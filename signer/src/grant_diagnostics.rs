use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const MAX_GRANTS: usize = 1000;
const MAX_EVENTS_PER_GRANT: usize = 64;
const MAX_TEAM_RESPONSE: usize = 200;
const MAX_KEY_FIELD_BYTES: usize = 128;
const MAX_RELAY_URL_BYTES: usize = 256;
const MAX_DETAILS_JSON_BYTES: usize = 1024;

/// Map an untrusted NIP-46 method string onto a closed static allowlist so
/// unauthenticated traffic can never allocate arbitrary strings in memory or
/// bloat the control-socket diagnostics payload.
pub fn sanitize_method(method: Option<&str>) -> Option<&'static str> {
    let raw = method?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(match raw {
        "connect" => "connect",
        "get_public_key" => "get_public_key",
        "sign_event" => "sign_event",
        "get_relays" => "get_relays",
        "switch_relays" => "switch_relays",
        "nip04_encrypt" => "nip04_encrypt",
        "nip04_decrypt" => "nip04_decrypt",
        "nip44_encrypt" => "nip44_encrypt",
        "nip44_decrypt" => "nip44_decrypt",
        "ping" => "ping",
        "logout" => "logout",
        _ => "other",
    })
}

fn bound_string(value: Option<String>, max_bytes: usize) -> Option<String> {
    let mut s = value?;
    if s.len() > max_bytes {
        let mut end = max_bytes;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        s.truncate(end);
    }
    Some(s)
}

fn bound_details(details: serde_json::Value) -> serde_json::Value {
    if !details.is_object() {
        return serde_json::json!({});
    }
    match serde_json::to_string(&details) {
        Ok(serialized) if serialized.len() <= MAX_DETAILS_JSON_BYTES => details,
        _ => serde_json::json!({}),
    }
}

/// Non-sensitive operational diagnostics for NIP-46 traffic addressed to a known
/// grant that was dropped before durable request admission (e.g., reused
/// invitation secrets, unpaired client pubkeys, decrypt failures, or rate limits).
///
/// Kept strictly in a bounded in-memory ring buffer so unauthenticated relay
/// traffic can never consume SQLite storage or affect admission capacity.
#[derive(Clone, Debug, Serialize)]
pub struct GrantDiagnosticEvent {
    pub id: u64,
    pub occurred_at: i64,
    pub team_id: i64,
    pub stored_key_id: i64,
    pub grant_id: i64,
    pub client_public_key: Option<String>,
    pub event_id: Option<String>,
    pub method: Option<&'static str>,
    pub outcome: &'static str,
    pub reason_code: &'static str,
    pub relay_url: Option<String>,
    pub details: serde_json::Value,
}

#[derive(Default)]
pub struct GrantDiagnostics {
    next_id: AtomicU64,
    by_grant: Mutex<HashMap<(i64, i64), VecDeque<GrantDiagnosticEvent>>>,
}

impl GrantDiagnostics {
    #[allow(clippy::too_many_arguments)]
    pub fn record_drop(
        &self,
        team_id: i64,
        stored_key_id: i64,
        grant_id: i64,
        client_public_key: Option<String>,
        event_id: Option<String>,
        method: Option<&str>,
        reason_code: &'static str,
        relay_url: Option<String>,
        details: serde_json::Value,
    ) {
        let now = chrono::Utc::now().timestamp();
        let key = (team_id, grant_id);
        let client_public_key = bound_string(client_public_key, MAX_KEY_FIELD_BYTES);
        let event_id = bound_string(event_id, MAX_KEY_FIELD_BYTES);
        let relay_url = bound_string(relay_url, MAX_RELAY_URL_BYTES);
        let method = sanitize_method(method);
        let details = bound_details(details);

        let mut map = self.by_grant.lock().unwrap_or_else(|e| e.into_inner());
        if !map.contains_key(&key) && map.len() >= MAX_GRANTS {
            // Evict the grant whose latest event is oldest to keep memory bounded.
            if let Some(oldest_key) = map
                .iter()
                .min_by_key(|(_, queue)| queue.back().map_or(0, |e| e.occurred_at))
                .map(|(&k, _)| k)
            {
                map.remove(&oldest_key);
            }
        }
        let queue = map.entry(key).or_default();
        // If a grant rowid was reused under the same team for a different key, reset the bucket.
        if queue
            .front()
            .is_some_and(|existing| existing.stored_key_id != stored_key_id)
        {
            queue.clear();
        }
        // Cross-relay duplicate copies of the exact same dropped event ID collapse to one entry.
        if let Some(ref eid) = event_id {
            if queue.iter().any(|existing| {
                existing.event_id.as_deref() == Some(eid.as_str())
                    && existing.reason_code == reason_code
            }) {
                return;
            }
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        queue.push_back(GrantDiagnosticEvent {
            id,
            occurred_at: now,
            team_id,
            stored_key_id,
            grant_id,
            client_public_key,
            event_id,
            method,
            outcome: "dropped",
            reason_code,
            relay_url,
            details,
        });
        while queue.len() > MAX_EVENTS_PER_GRANT {
            queue.pop_front();
        }
    }

    pub fn remove_team(&self, team_id: i64) {
        let mut map = self.by_grant.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|&(tid, _), _| tid != team_id);
    }

    pub fn remove_stored_key(&self, team_id: i64, stored_key_id: i64) {
        let mut map = self.by_grant.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|&(tid, _), queue| {
            if tid != team_id {
                return true;
            }
            queue.retain(|event| event.stored_key_id != stored_key_id);
            !queue.is_empty()
        });
    }

    pub fn list_for_team(&self, team_id: i64) -> Vec<GrantDiagnosticEvent> {
        let mut items: Vec<GrantDiagnosticEvent> = {
            let map = self.by_grant.lock().unwrap_or_else(|e| e.into_inner());
            map.iter()
                .filter(|(&(tid, _), _)| tid == team_id)
                .flat_map(|(_, queue)| queue.iter())
                .cloned()
                .collect()
        };
        items.sort_by(|a, b| {
            b.occurred_at
                .cmp(&a.occurred_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        items.truncate(MAX_TEAM_RESPONSE);
        items
    }

    pub fn recent_count_for_grant(&self, team_id: i64, grant_id: i64) -> usize {
        let map = self.by_grant.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&(team_id, grant_id)).map_or(0, VecDeque::len)
    }

    pub fn counts_for_team(&self, team_id: i64) -> HashMap<i64, usize> {
        let map = self.by_grant.lock().unwrap_or_else(|e| e.into_inner());
        let mut counts = HashMap::new();
        for (&(tid, grant_id), queue) in map.iter() {
            if tid == team_id && !queue.is_empty() {
                counts.insert(grant_id, queue.len());
            }
        }
        counts
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_is_bounded_deduplicates_event_ids_and_isolates_teams() {
        let diagnostics = GrantDiagnostics::default();
        for i in 0..80 {
            diagnostics.record_drop(
                1,
                10,
                100,
                Some("aaaa".into()),
                Some(format!("event-{i}")),
                Some("connect"),
                "secret_already_consumed",
                Some("wss://nos.lol".into()),
                serde_json::json!({"invitation_id": 4}),
            );
        }
        // Duplicate of an already recorded event_id is ignored.
        diagnostics.record_drop(
            1,
            10,
            100,
            Some("aaaa".into()),
            Some("event-79".into()),
            Some("connect"),
            "secret_already_consumed",
            Some("wss://relay.primal.net".into()),
            serde_json::json!({"invitation_id": 4}),
        );
        // Different team is isolated even if grant_id collides.
        diagnostics.record_drop(
            2,
            20,
            100,
            Some("bbbb".into()),
            Some("other-event".into()),
            Some("sign_event"),
            "no_active_session",
            None,
            serde_json::json!({}),
        );

        assert_eq!(
            diagnostics.recent_count_for_grant(1, 100),
            MAX_EVENTS_PER_GRANT
        );
        assert_eq!(diagnostics.recent_count_for_grant(2, 100), 1);
        let team1 = diagnostics.list_for_team(1);
        assert_eq!(team1.len(), MAX_EVENTS_PER_GRANT);
        assert_eq!(team1[0].event_id.as_deref(), Some("event-79"));
        assert_eq!(team1.last().unwrap().event_id.as_deref(), Some("event-16"));

        let team2 = diagnostics.list_for_team(2);
        assert_eq!(team2.len(), 1);
        assert_eq!(team2[0].grant_id, 100);
        assert_eq!(diagnostics.counts_for_team(2).get(&100), Some(&1));

        diagnostics.remove_team(1);
        assert!(diagnostics.list_for_team(1).is_empty());
        assert_eq!(diagnostics.list_for_team(2).len(), 1);
    }

    #[test]
    fn untrusted_method_and_oversized_fields_are_bounded() {
        let diagnostics = GrantDiagnostics::default();
        let huge_method = "x".repeat(65_000);
        let huge_relay = format!("wss://example.com/{}", "a".repeat(2000));
        let huge_details = serde_json::json!({ "blob": "z".repeat(4000) });

        diagnostics.record_drop(
            1,
            10,
            100,
            Some("a".repeat(500)),
            Some("e".repeat(500)),
            Some(&huge_method),
            "malformed_request",
            Some(huge_relay),
            huge_details,
        );

        let items = diagnostics.list_for_team(1);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].method, Some("other"));
        assert_eq!(
            items[0].client_public_key.as_ref().unwrap().len(),
            MAX_KEY_FIELD_BYTES
        );
        assert_eq!(
            items[0].event_id.as_ref().unwrap().len(),
            MAX_KEY_FIELD_BYTES
        );
        assert_eq!(
            items[0].relay_url.as_ref().unwrap().len(),
            MAX_RELAY_URL_BYTES
        );
        assert_eq!(items[0].details, serde_json::json!({}));
    }
}
