import { expect, test } from "bun:test";
import {
    grantState,
    kindLabel,
    mergeTrace,
    policyCapabilityChips,
    relativeTime,
} from "./diagnostics";
import type { AuditEvent, Grant, GrantDiagnosticEvent, Policy, StoredKey } from "#lib/types";

const key: StoredKey = {
    id: 1,
    team_id: 1,
    name: "Zapstore Publisher",
    public_key: "a".repeat(64),
    created_at: 1000,
    updated_at: 1000,
};

const policy: Policy = {
    id: 2,
    team_id: 1,
    name: "Zapstore Releases",
    revision: 1,
    created_at: 1000,
    updated_at: 1000,
    document: {
        version: 1,
        capabilities: {
            sign_event: { allowed_kinds: [32267, 30063, 3063] },
            nip44_encrypt: { recipient: "self_only" },
        },
    },
};

const grant: Grant = {
    id: 3,
    team_id: 1,
    stored_key_id: 1,
    stored_key_name: key.name,
    stored_key_public_key: key.public_key,
    policy_id: 2,
    policy_name: policy.name,
    name: "nak CLI",
    remote_signer_public_key: "b".repeat(64),
    expires_at: null,
    revoked_at: null,
    created_at: 1000,
    updated_at: 1000,
    active_sessions: 1,
    claimable_invitations: 0,
    invitations: [],
};

test("merges durable audit denials and in-memory drops with actionable hints", () => {
    const audit: AuditEvent[] = [
        {
            id: 10,
            occurred_at: 2000,
            stored_key_id: 1,
            grant_id: 3,
            session_id: 7,
            actor_public_key: "c".repeat(64),
            action: "nip46.sign_event",
            outcome: "denied",
            reason_code: "policy_denied",
            request_event_id: "e".repeat(64),
            details: { kind: 24242, relay_in: "wss://nos.lol" },
        },
    ];
    const drops: GrantDiagnosticEvent[] = [
        {
            id: 1,
            occurred_at: 2010,
            team_id: 1,
            stored_key_id: 1,
            grant_id: 3,
            client_public_key: "d".repeat(64),
            event_id: "f".repeat(64),
            method: "connect",
            outcome: "dropped",
            reason_code: "secret_already_consumed",
            relay_url: "wss://nos.lol",
            details: {
                invitation_id: 4,
                claimed_by_client_public_key: "c".repeat(64),
            },
        },
    ];

    const trace = mergeTrace(audit, drops, { keys: [key], grants: [grant], policies: [policy] });
    expect(trace).toHaveLength(2);

    expect(trace[0].badge).toBe("DROPPED");
    expect(trace[0].grant_name).toBe("nak CLI");
    expect(trace[0].summary).toContain("Invite #4");
    expect(trace[0].hint).toContain("NOSTR_CLIENT_KEY");

    expect(trace[1].badge).toBe("DENIED");
    expect(trace[1].requested_kind).toBe(24242);
    expect(trace[1].requested_kind_name).toBe("Blossom auth");
    expect(trace[1].summary).toContain("kind 24242");
    expect(trace[1].summary).toContain("Zapstore Releases");
    expect(trace[1].relay_in).toBe("wss://nos.lol");
});

test("computes grant states, policy chips, kind names, and relative times", () => {
    expect(grantState(grant, 2000)).toBe("connected");
    expect(grantState({ ...grant, active_sessions: 0, claimable_invitations: 1 }, 2000)).toBe("awaiting_pairing");
    expect(grantState({ ...grant, active_sessions: 0, claimable_invitations: 0 }, 2000)).toBe("inactive");
    expect(grantState({ ...grant, expires_at: 1999 }, 2000)).toBe("expired");
    expect(grantState({ ...grant, revoked_at: 1500 }, 2000)).toBe("revoked");

    expect(policyCapabilityChips(policy)).toEqual([
        "kind 32267",
        "kind 30063",
        "kind 3063",
        "nip44_encrypt: self",
    ]);
    expect(kindLabel(32267)).toBe("Software application (NIP-82)");
    expect(relativeTime(1940, 2000)).toBe("1m ago");
    expect(relativeTime(5600, 2000)).toBe("in 1h");
});
