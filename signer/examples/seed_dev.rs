//! Local development fixture seeder.
//!
//! Populates a disposable SQLite database with realistic fake teams, throwaway
//! keys, policies, grants, sessions, invitations, and audit log entries so the
//! workspace UI and troubleshooting log can be explored without creating data
//! manually. Never prints private keys, invitation secrets, or bunker URIs.
//!
//! Usage:
//!   KEYCAST_ROOT_KEY_FILE=./master.key \
//!   KEYCAST_DATABASE_PATH=/tmp/keycast-local-preview/keycast-v2.db \
//!   cargo run --example seed_dev -- --admin <64-char-hex-or-npub>

use std::path::{Path, PathBuf};

use keycast_core::database::{migrations_path_from_env, Database};
use keycast_core::v2::envelope::EnvelopeCipher;
use keycast_core::v2::policy::RequestedCapabilities;
use keycast_signer::maintenance;
use keycast_signer::store::Store;
use nostr::prelude::{Keys, PublicKey};
use sqlx::{query::query, query_scalar::query_scalar};
use zeroize::Zeroizing;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut admin_input: Option<String> = None;
    while let Some(arg) = args.next() {
        if arg == "--admin" {
            admin_input = args.next();
        }
    }
    let admin_raw = admin_input.ok_or("usage: seed_dev --admin <hex-or-npub>")?;
    let admin_pk = PublicKey::parse(&admin_raw)?.to_hex();

    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("signer crate must have a repository parent");
    let raw_db_path = std::env::var("KEYCAST_DATABASE_PATH").map_err(|_| {
        "KEYCAST_DATABASE_PATH must be set explicitly to a disposable dev database path"
    })?;
    let db_path = PathBuf::from(raw_db_path);
    let default_repo_db = repo_root.join("database");
    if db_path.starts_with(&default_repo_db) || db_path.starts_with("database") {
        return Err("refusing to seed inside the repository database/ directory; use a disposable path such as /tmp/keycast-dev/keycast-v2.db".into());
    }
    let _signer_lock = maintenance::lock(&maintenance::signer_path(&db_path), false)?;
    let _maint_lock = maintenance::lock(&maintenance::maintenance_path(&db_path), false)?;
    let database = Database::new(db_path.clone(), migrations_path_from_env(repo_root)).await?;
    let cipher = EnvelopeCipher::load()?;
    let store = Store::new(database.pool.clone(), cipher);
    keycast_signer::maintenance::verify_root(&store).await?;

    let existing_teams: i64 = query_scalar("SELECT count(*) FROM teams")
        .fetch_one(&store.pool)
        .await?;
    if existing_teams > 0 {
        println!(
            "Database {} already has {existing_teams} team(s); skipping seed.",
            db_path.display()
        );
        return Ok(());
    }

    let now = chrono::Utc::now().timestamp();
    let teammate_admin = Keys::generate().public_key().to_hex();
    let teammate_member = Keys::generate().public_key().to_hex();

    for pk in [&admin_pk, &teammate_admin, &teammate_member] {
        query("INSERT OR IGNORE INTO users(public_key) VALUES (?)")
            .bind(pk)
            .execute(&store.pool)
            .await?;
    }

    // Team 1: Zapstore Ops
    let team_ops = create_team(&store, "Zapstore Ops", "zapstore-ops", &admin_pk).await?;
    query("INSERT INTO team_members(team_id, user_public_key, role) VALUES (?, ?, 'admin')")
        .bind(team_ops)
        .bind(&teammate_admin)
        .execute(&store.pool)
        .await?;
    query("INSERT INTO team_members(team_id, user_public_key, role) VALUES (?, ?, 'member')")
        .bind(team_ops)
        .bind(&teammate_member)
        .execute(&store.pool)
        .await?;

    let policy_zapstore = create_policy(
        &store,
        team_ops,
        "Zapstore Releases",
        r#"{"version":1,"capabilities":{"sign_event":{"allowed_kinds":[32267,30063,3063]}}}"#,
    )
    .await?;
    let policy_social = create_policy(
        &store,
        team_ops,
        "Social Notes & DMs",
        r#"{"version":1,"capabilities":{"sign_event":{"allowed_kinds":[1,7]},"nip44_encrypt":{"recipient":"any"},"nip44_decrypt":{"recipient":"any"}}}"#,
    )
    .await?;
    let policy_announce = create_policy(
        &store,
        team_ops,
        "Release Announcements",
        r#"{"version":1,"capabilities":{"sign_event":{"allowed_kinds":[1,30023]}}}"#,
    )
    .await?;

    let pub_key = Keys::generate();
    let key_publisher = store
        .seal_stored_key(
            team_ops,
            &admin_pk,
            "Zapstore Publisher".to_string(),
            Zeroizing::new(pub_key.secret_key().to_secret_hex()),
        )
        .await?;

    let ann_key = Keys::generate();
    let key_announcer = store
        .seal_stored_key(
            team_ops,
            &admin_pk,
            "Release Announcer".to_string(),
            Zeroizing::new(ann_key.secret_key().to_secret_hex()),
        )
        .await?;

    // Grant 1: Connected nak CLI with claimed invite, active session, allowed signs + policy_denied kind 24242
    let (grant_nak, _inv_nak_1, uri_nak_1) = store
        .create_grant(
            team_ops,
            &admin_pk,
            key_publisher.id,
            policy_zapstore,
            "nak — Release CLI (Alex)".to_string(),
            None,
            now + 24 * 3600,
        )
        .await?;
    let rt_nak = store
        .grant_for_recipient(&grant_nak.remote_signer_public_key)
        .await?
        .expect("runtime grant");
    let client_alex = Keys::generate().public_key();
    let secret_nak_1 = extract_secret(&uri_nak_1);
    let session_nak = store
        .claim_invitation(
            &rt_nak,
            &client_alex,
            &secret_nak_1,
            &RequestedCapabilities::unrestricted(),
            Some(r#"{"name":"nak CLI"}"#),
        )
        .await?;

    // Seed realistic audit rows (allowed NIP-82 signs + policy_denied Blossom kind 24242)
    insert_audit(
        &store,
        now - 240,
        team_ops,
        key_publisher.id,
        grant_nak.id,
        Some(session_nak),
        &client_alex.to_hex(),
        "nip46.sign_event",
        "allowed",
        None,
        r#"{"kind":32267,"relay_in":"wss://nos.lol"}"#,
    )
    .await?;
    insert_audit(
        &store,
        now - 180,
        team_ops,
        key_publisher.id,
        grant_nak.id,
        Some(session_nak),
        &client_alex.to_hex(),
        "nip46.sign_event",
        "allowed",
        None,
        r#"{"kind":3063,"relay_in":"wss://relay.primal.net"}"#,
    )
    .await?;
    insert_audit(
        &store,
        now - 120,
        team_ops,
        key_publisher.id,
        grant_nak.id,
        Some(session_nak),
        &client_alex.to_hex(),
        "nip46.sign_event",
        "allowed",
        None,
        r#"{"kind":30063,"relay_in":"wss://nos.lol"}"#,
    )
    .await?;
    insert_audit(
        &store,
        now - 60,
        team_ops,
        key_publisher.id,
        grant_nak.id,
        Some(session_nak),
        &client_alex.to_hex(),
        "nip46.sign_event",
        "denied",
        Some("policy_denied"),
        r#"{"kind":24242,"relay_in":"wss://nos.lol"}"#,
    )
    .await?;

    // Grant 2: Awaiting pairing (pending one-time invite)
    let (_grant_jumble, _inv_jumble, _uri_jumble) = store
        .create_grant(
            team_ops,
            &admin_pk,
            key_publisher.id,
            policy_social,
            "Jumble Web".to_string(),
            None,
            now + 23 * 3600,
        )
        .await?;

    // Grant 3: Revoked staging grant
    let (grant_staging, _inv_staging, _uri_staging) = store
        .create_grant(
            team_ops,
            &admin_pk,
            key_publisher.id,
            policy_zapstore,
            "CI Runner — Old Staging".to_string(),
            None,
            now + 12 * 3600,
        )
        .await?;
    store.revoke_grant(grant_staging.id, &admin_pk).await?;

    // Grant 4: Release Announcer Bot (active session + signed note)
    let (grant_bot, _inv_bot, uri_bot) = store
        .create_grant(
            team_ops,
            &admin_pk,
            key_announcer.id,
            policy_announce,
            "Release Announcer Bot".to_string(),
            None,
            now + 24 * 3600,
        )
        .await?;
    let rt_bot = store
        .grant_for_recipient(&grant_bot.remote_signer_public_key)
        .await?
        .expect("runtime grant");
    let client_bot = Keys::generate().public_key();
    let session_bot = store
        .claim_invitation(
            &rt_bot,
            &client_bot,
            &extract_secret(&uri_bot),
            &RequestedCapabilities::unrestricted(),
            Some(r#"{"name":"release-bot"}"#),
        )
        .await?;
    insert_audit(
        &store,
        now - 3600,
        team_ops,
        key_announcer.id,
        grant_bot.id,
        Some(session_bot),
        &client_bot.to_hex(),
        "nip46.sign_event",
        "allowed",
        None,
        r#"{"kind":1,"relay_in":"wss://relay.primal.net"}"#,
    )
    .await?;

    // Team 2: Personal
    let team_personal = create_team(&store, "Personal", "personal", &admin_pk).await?;
    let policy_personal = create_policy(
        &store,
        team_personal,
        "Basic Social",
        r#"{"version":1,"capabilities":{"sign_event":{"allowed_kinds":[1,7]}}}"#,
    )
    .await?;
    let personal_key = Keys::generate();
    let key_personal = store
        .seal_stored_key(
            team_personal,
            &admin_pk,
            "Personal Test Identity".to_string(),
            Zeroizing::new(personal_key.secret_key().to_secret_hex()),
        )
        .await?;
    let (_grant_personal, _inv_personal, _uri_personal) = store
        .create_grant(
            team_personal,
            &admin_pk,
            key_personal.id,
            policy_personal,
            "Mobile Client".to_string(),
            None,
            now + 48 * 3600,
        )
        .await?;

    println!(
        "Seeded local preview DB at {} for admin {} (2 teams, 3 keys, 4 policies, 5 connections).",
        db_path.display(),
        &admin_pk[..12]
    );
    Ok(())
}

fn extract_secret(bunker_uri: &str) -> String {
    let encoded = bunker_uri
        .split("secret=")
        .nth(1)
        .expect("bunker URI secret");
    urlencoding::decode(encoded)
        .expect("valid urlencoding")
        .into_owned()
}

async fn create_team(
    store: &Store,
    name: &str,
    slug: &str,
    admin_pk: &str,
) -> Result<i64, Box<dyn std::error::Error>> {
    let id: i64 = query_scalar("INSERT INTO teams(name, slug) VALUES (?, ?) RETURNING id")
        .bind(name)
        .bind(slug)
        .fetch_one(&store.pool)
        .await?;
    query("INSERT INTO team_members(team_id, user_public_key, role) VALUES (?, ?, 'admin')")
        .bind(id)
        .bind(admin_pk)
        .execute(&store.pool)
        .await?;
    Ok(id)
}

async fn create_policy(
    store: &Store,
    team_id: i64,
    name: &str,
    document: &str,
) -> Result<i64, Box<dyn std::error::Error>> {
    let id: i64 =
        query_scalar("INSERT INTO policies(team_id, name, document) VALUES (?, ?, ?) RETURNING id")
            .bind(team_id)
            .bind(name)
            .bind(document)
            .fetch_one(&store.pool)
            .await?;
    Ok(id)
}

#[allow(clippy::too_many_arguments)]
async fn insert_audit(
    store: &Store,
    occurred_at: i64,
    team_id: i64,
    stored_key_id: i64,
    grant_id: i64,
    session_id: Option<i64>,
    actor_public_key: &str,
    action: &str,
    outcome: &str,
    reason_code: Option<&str>,
    details: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    query(
        "INSERT INTO audit_events(
            occurred_at, team_id, stored_key_id, grant_id, session_id,
            actor_public_key, action, outcome, reason_code, details
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(occurred_at)
    .bind(team_id)
    .bind(stored_key_id)
    .bind(grant_id)
    .bind(session_id)
    .bind(actor_public_key)
    .bind(action)
    .bind(outcome)
    .bind(reason_code)
    .bind(details)
    .execute(&store.pool)
    .await?;
    Ok(())
}
