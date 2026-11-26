use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

use crate::management::state::SignerClientError;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("invalid input: {0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("permission denied")]
    Forbidden,
    #[error("resource not found")]
    NotFound,
    #[error("signer unavailable")]
    SignerUnavailable,
    #[error("internal server error")]
    Internal,
}

impl ApiError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::BadRequest(message.into())
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }

    pub fn from_database_conflict(error: sqlx::Error, message: impl Into<String>) -> Self {
        if error
            .as_database_error()
            .is_some_and(|db| db.is_unique_violation())
        {
            Self::Conflict(message.into())
        } else {
            Self::Database(error)
        }
    }
}

impl From<SignerClientError> for ApiError {
    fn from(error: SignerClientError) -> Self {
        match error {
            SignerClientError::Unavailable => Self::SignerUnavailable,
            SignerClientError::Rejected { code, .. }
                if code == "invalid_input" || code == "not_claimable" =>
            {
                Self::BadRequest("signer rejected the request".to_string())
            }
            SignerClientError::Rejected { code, message } if code == "conflict" => {
                Self::Conflict(message)
            }
            SignerClientError::Rejected { code, .. } if code == "not_found" => Self::NotFound,
            SignerClientError::InvalidResponse | SignerClientError::Rejected { .. } => {
                Self::Internal
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self {
            Self::Database(error) => {
                tracing::error!(error = %error, "database request failed");
                StatusCode::INTERNAL_SERVER_ERROR
            }
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::SignerUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let message = self.to_string();
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
