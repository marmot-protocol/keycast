import { POLICY_USE_CASES } from "#lib/policy/catalog";
import { validateDocument } from "#lib/policy/editor";
import type {
    AuditEvent,
    Grant,
    GrantDiagnosticEvent,
    Policy,
    StoredKey,
} from "#lib/types";

const KIND_LABELS: ReadonlyMap<number, string> = (() => {
    const map = new Map<number, string>([
        [0, "Profile metadata"],
        [1, "Short text note"],
        [3, "Follow list"],
        [5, "Deletion request"],
        [7, "Reaction"],
        [10002, "Relay list (NIP-65)"],
        [22242, "Relay auth (NIP-42)"],
        [24242, "Blossom auth"],
        [27235, "HTTP auth (NIP-98)"],
        [30023, "Long-form article"],
        [3063, "Software asset (NIP-82)"],
        [30063, "Software release (NIP-82)"],
        [32267, "Software application (NIP-82)"],
    ]);
    for (const useCase of POLICY_USE_CASES) {
        for (const item of useCase.items) {
            for (const kind of item.kinds) {
                if (!map.has(kind)) map.set(kind, item.name);
            }
        }
        for (const transport of useCase.transport ?? []) {
            if (!map.has(transport.kind)) map.set(transport.kind, transport.name);
        }
    }
    return map;
})();

export function kindLabel(kind: number): string | null {
    return KIND_LABELS.get(kind) ?? null;
}

export function shortKey(pubkey: string | null | undefined): string {
    if (!pubkey) return "unknown";
    if (pubkey.length <= 16) return pubkey;
    return `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`;
}

export function relativeTime(unixSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
    const diff = unixSeconds - nowSeconds;
    const abs = Math.abs(diff);
    const future = diff > 0;
    const fmt = (value: number, unit: string) => (future ? `in ${value}${unit}` : `${value}${unit} ago`);
    if (abs < 5) return "just now";
    if (abs < 60) return fmt(abs, "s");
    if (abs < 3600) return fmt(Math.floor(abs / 60), "m");
    if (abs < 86400) return fmt(Math.floor(abs / 3600), "h");
    return fmt(Math.floor(abs / 86400), "d");
}

export type GrantState =
    | "connected"
    | "awaiting_pairing"
    | "inactive"
    | "expired"
    | "revoked";

export function grantState(
    grant: Pick<Grant, "revoked_at" | "expires_at" | "active_sessions" | "claimable_invitations">,
    nowSeconds = Math.floor(Date.now() / 1000),
): GrantState {
    if (grant.revoked_at !== null) return "revoked";
    if (grant.expires_at !== null && grant.expires_at <= nowSeconds) return "expired";
    if (grant.active_sessions > 0) return "connected";
    if (grant.claimable_invitations > 0) return "awaiting_pairing";
    return "inactive";
}

export function grantStateLabel(state: GrantState): string {
    switch (state) {
        case "connected":
            return "Connected";
        case "awaiting_pairing":
            return "Awaiting pairing";
        case "inactive":
            return "No active session";
        case "expired":
            return "Expired";
        case "revoked":
            return "Revoked";
    }
}

export function policyCapabilityChips(policy: Policy | undefined): string[] {
    if (!policy) return [];
    try {
        validateDocument(policy.document);
    } catch {
        // Fail closed on unknown policy versions, extra fields, or invalid scopes.
        return [];
    }
    const caps = policy.document.capabilities;
    const chips: string[] = [];
    if (caps.sign_event?.allowed_kinds?.length) {
        for (const kind of caps.sign_event.allowed_kinds) {
            chips.push(`kind ${kind}`);
        }
    }
    for (const method of [
        "nip44_encrypt",
        "nip44_decrypt",
        "nip04_encrypt",
        "nip04_decrypt",
    ] as const) {
        const cap = caps[method];
        if (cap) {
            chips.push(`${method}: ${cap.recipient === "self_only" ? "self" : "any"}`);
        }
    }
    return chips;
}

export type TraceSeverity = "ok" | "warn" | "err" | "info";
export type TraceCategory = "signing" | "drop" | "management";

export type TraceEntry = {
    uid: string;
    source: "audit" | "diagnostic";
    category: TraceCategory;
    occurred_at: number;
    stored_key_id: number | null;
    stored_key_name: string | null;
    grant_id: number | null;
    grant_name: string | null;
    policy_id: number | null;
    policy_name: string | null;
    session_id: number | null;
    client_public_key: string | null;
    action: string;
    badge: string;
    severity: TraceSeverity;
    reason_code: string | null;
    requested_kind: number | null;
    requested_kind_name: string | null;
    relay_in: string | null;
    event_id: string | null;
    summary: string;
    hint: string | null;
};

export function mergeTrace(
    auditEvents: AuditEvent[],
    diagnostics: GrantDiagnosticEvent[],
    context: {
        keys: StoredKey[];
        grants: Grant[];
        policies: Policy[];
    },
): TraceEntry[] {
    const keyById = new Map(context.keys.map((k) => [k.id, k]));
    const grantById = new Map(context.grants.map((g) => [g.id, g]));
    const policyById = new Map(context.policies.map((p) => [p.id, p]));

    const entries: TraceEntry[] = [];

    for (const event of auditEvents) {
        const grant = event.grant_id !== null ? grantById.get(event.grant_id) : undefined;
        const keyId = event.stored_key_id ?? grant?.stored_key_id ?? null;
        const key = keyId !== null ? keyById.get(keyId) : undefined;
        const policy = grant ? policyById.get(grant.policy_id) : undefined;
        const details = event.details ?? {};
        const kind = typeof details.kind === "number" ? details.kind : null;
        const kindName = kind !== null ? kindLabel(kind) : null;
        const relayIn = typeof details.relay_in === "string" ? details.relay_in : null;
        const isNip46 = event.action.startsWith("nip46.") || event.action === "session.connect";
        const isProblem = event.outcome === "denied" || event.outcome === "failed";

        let badge = event.outcome.toUpperCase();
        let severity: TraceSeverity = "info";
        if (event.action === "session.connect" && event.outcome === "succeeded") {
            badge = "CONNECTED";
            severity = "ok";
        } else if (event.outcome === "allowed") {
            badge = "ALLOWED";
            severity = "ok";
        } else if (event.outcome === "denied") {
            badge = "DENIED";
            severity = "warn";
        } else if (event.outcome === "failed") {
            badge = "FAILED";
            severity = "err";
        } else if (!isNip46) {
            badge = "ADMIN";
            severity = "info";
        }

        const { summary, hint } = describeAuditEvent(event, {
            kind,
            kindName,
            policy,
            grantName: grant?.name ?? null,
        });

        entries.push({
            uid: `audit-${event.id}`,
            source: "audit",
            category: isNip46 ? "signing" : "management",
            occurred_at: event.occurred_at,
            stored_key_id: keyId,
            stored_key_name: key?.name ?? grant?.stored_key_name ?? null,
            grant_id: event.grant_id,
            grant_name: grant?.name ?? null,
            policy_id: grant?.policy_id ?? null,
            policy_name: policy?.name ?? grant?.policy_name ?? null,
            session_id: event.session_id,
            client_public_key: event.actor_public_key,
            action: event.action,
            badge,
            severity: isProblem && severity === "info" ? "warn" : severity,
            reason_code: event.reason_code,
            requested_kind: kind,
            requested_kind_name: kindName,
            relay_in: relayIn,
            event_id: event.request_event_id,
            summary,
            hint,
        });
    }

    for (const drop of diagnostics) {
        const grant = grantById.get(drop.grant_id);
        const key = keyById.get(drop.stored_key_id);
        const policy = grant ? policyById.get(grant.policy_id) : undefined;
        const { summary, hint } = describeDropEvent(drop);

        entries.push({
            uid: `drop-${drop.id}`,
            source: "diagnostic",
            category: "drop",
            occurred_at: drop.occurred_at,
            stored_key_id: drop.stored_key_id,
            stored_key_name: key?.name ?? grant?.stored_key_name ?? null,
            grant_id: drop.grant_id,
            grant_name: grant?.name ?? null,
            policy_id: grant?.policy_id ?? null,
            policy_name: policy?.name ?? grant?.policy_name ?? null,
            session_id: null,
            client_public_key: drop.client_public_key,
            action: drop.method ? `nip46.${drop.method}` : "nip46.envelope",
            badge: "DROPPED",
            severity: "err",
            reason_code: drop.reason_code,
            requested_kind: null,
            requested_kind_name: null,
            relay_in: drop.relay_url,
            event_id: drop.event_id,
            summary,
            hint,
        });
    }

    entries.sort((a, b) => {
        if (b.occurred_at !== a.occurred_at) return b.occurred_at - a.occurred_at;
        const aNum = Number(a.uid.slice(a.uid.indexOf("-") + 1));
        const bNum = Number(b.uid.slice(b.uid.indexOf("-") + 1));
        if (Number.isFinite(aNum) && Number.isFinite(bNum) && a.source === b.source) {
            return bNum - aNum;
        }
        return b.uid.localeCompare(a.uid);
    });
    return entries;
}

function describeAuditEvent(
    event: AuditEvent,
    meta: {
        kind: number | null;
        kindName: string | null;
        policy: Policy | undefined;
        grantName: string | null;
    },
): { summary: string; hint: string | null } {
    const actor = shortKey(event.actor_public_key);
    if (event.action === "session.connect") {
        return {
            summary: `Client ${actor} claimed a one-time invitation and opened a signing session.`,
            hint: null,
        };
    }
    if (event.action === "nip46.sign_event") {
        const kindText =
            meta.kind !== null
                ? `kind ${meta.kind}${meta.kindName ? ` (${meta.kindName})` : ""}`
                : "an event";
        if (event.outcome === "allowed") {
            return {
                summary: `Signed ${kindText} for client ${actor}.`,
                hint: null,
            };
        }
        if (event.reason_code === "policy_denied") {
            const allowed = meta.policy?.document?.capabilities?.sign_event?.allowed_kinds ?? [];
            const policyText = meta.policy
                ? `policy "${meta.policy.name}" (allows: ${allowed.length ? allowed.join(", ") : "no signing kinds"})`
                : "the attached policy";
            return {
                summary: `Denied signing ${kindText} for client ${actor} — blocked by ${policyText}.`,
                hint:
                    meta.kind !== null
                        ? `Edit policy "${meta.policy?.name ?? "attached policy"}" to allow kind ${meta.kind} if this client should sign it.`
                        : "Review the attached policy's allowed event kinds.",
            };
        }
        if (event.reason_code === "pubkey_mismatch") {
            return {
                summary: `Denied ${kindText} from client ${actor} because the event template specified a different pubkey.`,
                hint: "Ensure the client omits pubkey or sets it to the hosted key's pubkey (returned by get_public_key).",
            };
        }
        if (event.reason_code === "invalid_event") {
            return {
                summary: `Denied malformed sign_event template from client ${actor}.`,
                hint: "NIP-46 expects { kind, content, tags, created_at } (optional zeroed id/pubkey/sig).",
            };
        }
    }
    if (
        event.action === "nip46.nip44_encrypt" ||
        event.action === "nip46.nip44_decrypt" ||
        event.action === "nip46.nip04_encrypt" ||
        event.action === "nip46.nip04_decrypt"
    ) {
        const method = event.action.replace("nip46.", "");
        const scope = typeof event.details?.recipient_scope === "string" ? event.details.recipient_scope : null;
        if (event.outcome === "allowed") {
            return {
                summary: `Completed ${method}${scope ? ` (${scope === "self" ? "self" : "counterparty"})` : ""} for client ${actor}.`,
                hint: null,
            };
        }
        if (event.reason_code === "policy_denied") {
            return {
                summary: `Denied ${method}${scope ? ` (${scope === "self" ? "self" : "counterparty"})` : ""} for client ${actor}.`,
                hint: `Enable ${method} on policy "${meta.policy?.name ?? "attached policy"}" if this client requires it.`,
            };
        }
    }
    if (event.action === "nip46.connect" && event.outcome === "allowed") {
        return {
            summary: `Acknowledged NIP-46 connect from client ${actor}.`,
            hint: null,
        };
    }
    if (event.action === "nip46.connect" && event.outcome === "denied") {
        if (event.reason_code === "invalid_requested_capabilities") {
            return {
                summary: `Rejected connect from client ${actor} due to unsupported requested permissions.`,
                hint: "Keycast accepts sign_event[:kind], nip04_encrypt/decrypt, and nip44_encrypt/decrypt in requested permissions.",
            };
        }
        return {
            summary: `Rejected connect from client ${actor}${event.reason_code ? ` (${event.reason_code})` : ""}.`,
            hint: "Verify the client is using a fresh one-time invitation or its already-paired client key.",
        };
    }
    if (event.action === "nip46.logout") {
        return {
            summary: `Client ${actor} logged out and ended its session.`,
            hint: "A new one-time invitation will be needed before this client can reconnect.",
        };
    }
    if (event.action === "nip46.get_public_key") {
        return { summary: `Returned hosted public key to client ${actor}.`, hint: null };
    }
    if (event.action === "nip46.ping") {
        return { summary: `Answered ping from client ${actor}.`, hint: null };
    }
    if (event.action === "nip46.switch_relays") {
        return { summary: `Returned active signing relays to client ${actor}.`, hint: null };
    }
    return {
        summary: `${event.action} ${event.outcome}${event.reason_code ? ` (${event.reason_code})` : ""}`,
        hint: null,
    };
}

function describeDropEvent(drop: GrantDiagnosticEvent): { summary: string; hint: string } {
    const client = shortKey(drop.client_public_key);
    const invId = typeof drop.details?.invitation_id === "number" ? drop.details.invitation_id : null;
    const claimedBy =
        typeof drop.details?.claimed_by_client_public_key === "string"
            ? shortKey(drop.details.claimed_by_client_public_key)
            : null;

    switch (drop.reason_code) {
        case "secret_already_consumed":
            return {
                summary: `Client ${client} tried to connect using ${invId ? `Invite #${invId}` : "an invitation secret"} that was already claimed${claimedBy ? ` by ${claimedBy}` : ""}. Ignored per NIP-46 (no reply sent).`,
                hint: claimedBy
                    ? `Reuse client key ${claimedBy} (for nak, pass --connect-as / NOSTR_CLIENT_KEY or upgrade nak), or click "+ New invite" to pair this client separately.`
                    : `Create a fresh one-time invitation on this connection, or reuse the original paired client key.`,
            };
        case "secret_missing":
            return {
                summary: `Client ${client} sent connect without an invitation secret. Ignored per NIP-46.`,
                hint: "Pair using the full one-time bunker:// URI including &secret=… (and keep the same client key on subsequent runs).",
            };
        case "secret_expired":
            return {
                summary: `Client ${client} tried to connect with expired ${invId ? `Invite #${invId}` : "invitation"}. Ignored.`,
                hint: `Create a new one-time invitation on this connection and hand the new bunker:// URI to the client.`,
            };
        case "secret_revoked":
            return {
                summary: `Client ${client} tried to connect with revoked ${invId ? `Invite #${invId}` : "invitation"}. Ignored.`,
                hint: `Create a new one-time invitation if this client should be paired.`,
            };
        case "secret_mismatch":
            return {
                summary: `Client ${client} sent connect with an unrecognized secret for this connection. Ignored.`,
                hint: "Check that the bunker:// URI wasn't truncated or copied from another grant, or generate a new invitation.",
            };
        case "no_active_session":
            return {
                summary: `Client ${client} sent ${drop.method ?? "a request"} without an active session on this connection. Ignored.`,
                hint: "This client has never paired, logged out, or was revoked — or it generated a new ephemeral client key. Pair it with a fresh invitation using a persistent client key.",
            };
        case "decrypt_failed":
            return {
                summary: `Could not NIP-44 decrypt a request from client ${client}. Ignored.`,
                hint: "Ensure the client uses NIP-44 encryption (not legacy NIP-04) and targets this connection's bunker pubkey.",
            };
        case "malformed_request":
            return {
                summary: `Dropped malformed NIP-46 JSON payload from client ${client}.`,
                hint: "Verify the client sends standard NIP-46 { id, method, params } requests.",
            };
        case "rate_limited": {
            const admission =
                typeof drop.details?.admission_reason === "string"
                    ? drop.details.admission_reason
                    : "admission limit";
            return {
                summary: `Rate-limited incoming request from client ${client} (${admission}).`,
                hint: "Wait a moment and retry; bursty unpaired connect attempts draw from a stricter newcomer limit.",
            };
        }
        default:
            return {
                summary: `Dropped ${drop.method ?? "NIP-46 request"} from client ${client} (${drop.reason_code}).`,
                hint: "Check client configuration and retry with a fresh invitation if needed.",
            };
    }
}
