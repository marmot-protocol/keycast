use axum::extract::FromRequestParts;
use axum::http::{request::Parts, StatusCode};
use axum::Json;
use nostr::prelude::Event;

pub struct AuthEvent(pub Event);

impl<S> FromRequestParts<S> for AuthEvent
where
    S: Send + Sync,
{
    type Rejection = (StatusCode, Json<serde_json::Value>);

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<Event>()
            .cloned()
            .map(Self)
            .ok_or_else(|| {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({ "error": "authentication required" })),
                )
            })
    }
}
