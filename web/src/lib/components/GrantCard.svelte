<script lang="ts">
    import Copy from "#lib/components/Copy.svelte";
    import type { Grant, GrantDiagnosticEvent, Policy } from "#lib/types";
    import { formattedUnixDateTime } from "#lib/utils/dates";
    import {
        grantState,
        grantStateLabel,
        policyCapabilityChips,
        relativeTime,
        shortKey,
    } from "#lib/utils/diagnostics";
    import { LinkSimple, Pulse, ShieldCheck } from "phosphor-svelte";

    let {
        grant,
        policy,
        drops = [],
        onRevoke,
        onCreateInvitation,
        onRevokeInvitation,
        onInspectLog,
        onEditPolicy,
    }: {
        grant: Grant;
        policy?: Policy;
        drops?: GrantDiagnosticEvent[];
        onRevokeInvitation: (
            grant: Grant,
            invitationId: number,
        ) => Promise<void>;
        onRevoke: (grant: Grant) => Promise<void> | void;
        onCreateInvitation: (grant: Grant) => Promise<void> | void;
        onInspectLog?: (grant: Grant) => void;
        onEditPolicy?: (policyId: number) => void;
    } = $props();

    let busy = $state(false);
    let showEndedSessions = $state(false);

    const status = $derived(grantState(grant));
    const statusLabel = $derived(grantStateLabel(status));
    const chips = $derived(policyCapabilityChips(policy));
    const activeSessions = $derived(
        (grant.sessions ?? []).filter((s) => s.ended_at === null),
    );
    const endedSessions = $derived(
        (grant.sessions ?? []).filter((s) => s.ended_at !== null),
    );
    const recentInvitations = $derived.by(() => {
        const list = grant.recent_invitations ?? [];
        const claimable = list.filter((i) => i.status === "claimable");
        const archived = list.filter((i) => i.status !== "claimable");
        return [...claimable, ...archived.slice(0, Math.max(0, 5 - claimable.length))];
    });
    function safeClientName(metadata: unknown): string | null {
        if (!metadata || typeof metadata !== "object") return null;
        const raw = (metadata as Record<string, unknown>).name;
        if (typeof raw !== "string") return null;
        const trimmed = raw.trim();
        if (!trimmed) return null;
        return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
    }
    const dropCount = $derived(Math.max(grant.recent_drops ?? 0, drops.length));
    const latestDrop = $derived(drops[0] ?? null);

    async function run(action: (grant: Grant) => Promise<void> | void) {
        busy = true;
        try {
            await action(grant);
        } finally {
            busy = false;
        }
    }

    function stateBadgeClass(): string {
        if (status === "connected") return "badge";
        if (status === "awaiting_pairing") return "badge badge-warning";
        if (status === "revoked" || status === "expired") return "badge badge-neutral";
        return "badge badge-neutral";
    }
</script>

<article class="grant-card" class:grant-card-revoked={status === "revoked" || status === "expired"}>
    <div class="grant-card-head">
        <div class="grant-card-title">
            <h3 class="text-sm font-semibold">{grant.name}</h3>
            <span class={stateBadgeClass()}>{statusLabel}</span>
            {#if dropCount > 0}
                <span class="badge badge-danger">{dropCount} dropped</span>
            {/if}
        </div>
        <div class="flex flex-wrap gap-2">
            {#if onInspectLog}
                <button
                    type="button"
                    class="button button-secondary"
                    onclick={() => onInspectLog(grant)}
                >
                    <Pulse size={14} /> Inspect log
                </button>
            {/if}
            {#if status !== "revoked" && status !== "expired"}
                <button
                    type="button"
                    onclick={() => run(onCreateInvitation)}
                    class="button button-secondary"
                    disabled={busy}
                >
                    <LinkSimple size={14} /> New invitation
                </button>
            {/if}
            {#if !grant.revoked_at}
                <button
                    type="button"
                    onclick={() => run(onRevoke)}
                    class="button button-danger"
                    disabled={busy}
                >
                    Revoke
                </button>
            {/if}
        </div>
    </div>

    <!-- Policy strip -->
    <div class="policy-strip">
        <span class="policy-strip-label">
            <ShieldCheck size={14} />
            <strong>{policy?.name ?? grant.policy_name ?? `Policy #${grant.policy_id}`}</strong>
            {#if policy}<span class="text-muted">rev {policy.revision}</span>{/if}
        </span>
        <div class="chip-list">
            {#each chips as chip}
                <span class="kind-chip">{chip}</span>
            {:else}
                <span class="text-xs text-muted">Policy details unavailable</span>
            {/each}
        </div>
        {#if onEditPolicy && policy}
            <button
                type="button"
                class="button button-quiet button-sm policy-edit-link"
                onclick={() => onEditPolicy(policy.id)}
            >
                Edit policy
            </button>
        {/if}
    </div>

    <!-- Paired Clients (Sessions) & One-Time Invitations -->
    <div class="grant-columns">
        <div class="grant-subbox">
            <div class="grant-subbox-head">
                <span>Paired clients (sessions)</span>
                <span class="font-mono">{grant.active_sessions} active</span>
            </div>
            {#if activeSessions.length > 0}
                {#each activeSessions as session (session.id)}
                    {@const clientName = safeClientName(session.client_metadata)}
                    <div class="subbox-row">
                        <div class="min-w-0">
                            <div class="flex items-center gap-1.5 flex-wrap">
                                {#if clientName}
                                    <span class="text-xs font-semibold">{clientName}</span>
                                {/if}
                                <code class="font-mono text-xs">{shortKey(session.client_public_key)}</code>
                                <Copy value={session.client_public_key} size="13" label="Copy client public key" />
                            </div>
                            <div class="text-[11px] text-muted mt-0.5">
                                Paired {relativeTime(session.connected_at)} · last seen {relativeTime(session.last_seen_at)}
                            </div>
                        </div>
                        <span class="badge">Active</span>
                    </div>
                {/each}
            {:else}
                <p class="text-xs text-muted py-1">
                    {#if grant.claimable_invitations > 0}
                        No client paired yet. Hand the one-time invitation URL to your app or CLI.
                    {:else if status === "revoked"}
                        All sessions were ended when this connection was revoked.
                    {:else}
                        No active client session. Create a new one-time invitation to pair a client.
                    {/if}
                </p>
            {/if}
            {#if endedSessions.length > 0}
                <button
                    type="button"
                    class="text-[11px] text-muted bordered mt-2"
                    onclick={() => (showEndedSessions = !showEndedSessions)}
                >
                    {showEndedSessions ? "Hide" : "Show"} {endedSessions.length} ended {endedSessions.length === 1 ? "session" : "sessions"}
                </button>
                {#if showEndedSessions}
                    <div class="mt-2 border-t border-line pt-2">
                        {#each endedSessions as session (session.id)}
                            <div class="subbox-row text-muted">
                                <div class="min-w-0">
                                    <code class="font-mono text-[11px]">{shortKey(session.client_public_key)}</code>
                                    <div class="text-[11px]">
                                        Paired {relativeTime(session.connected_at)} · ended {session.ended_at ? relativeTime(session.ended_at) : ""}
                                    </div>
                                </div>
                                <span class="badge badge-neutral">{session.end_reason ?? "ended"}</span>
                            </div>
                        {/each}
                    </div>
                {/if}
            {/if}
        </div>

        <div class="grant-subbox">
            <div class="grant-subbox-head">
                <span>One-time invitations</span>
                <span class="font-mono">{grant.claimable_invitations} claimable</span>
            </div>
            {#if recentInvitations.length > 0}
                {#each recentInvitations as invitation (invitation.id)}
                    <div class="subbox-row">
                        <div class="min-w-0">
                            <div class="text-xs font-medium flex items-center gap-1.5 flex-wrap">
                                {#if invitation.status === "claimed" && invitation.claimed_by_client_public_key}
                                    <span>Claimed by</span>
                                    <code class="font-mono text-xs">{shortKey(invitation.claimed_by_client_public_key)}</code>
                                    <Copy value={invitation.claimed_by_client_public_key} size="13" label="Copy client public key" />
                                {:else if invitation.status === "claimable"}
                                    <span>One-time link</span>
                                    <span class="text-[11px] font-normal text-muted" title={formattedUnixDateTime(invitation.created_at)}>
                                        · created {relativeTime(invitation.created_at)}
                                    </span>
                                {:else if invitation.status === "revoked"}
                                    <span>Revoked link</span>
                                    <span class="text-[11px] font-normal text-muted" title={formattedUnixDateTime(invitation.created_at)}>
                                        · created {relativeTime(invitation.created_at)}
                                    </span>
                                {:else}
                                    <span>Expired link</span>
                                    <span class="text-[11px] font-normal text-muted" title={formattedUnixDateTime(invitation.created_at)}>
                                        · created {relativeTime(invitation.created_at)}
                                    </span>
                                {/if}
                            </div>
                            <div class="text-[11px] text-muted mt-0.5">
                                {#if invitation.status === "claimable"}
                                    Expires {relativeTime(invitation.expires_at)} ({formattedUnixDateTime(invitation.expires_at)})
                                {:else if invitation.status === "claimed"}
                                    Claimed {invitation.consumed_at ? relativeTime(invitation.consumed_at) : ""}
                                    {#if invitation.consumed_at}
                                        ({formattedUnixDateTime(invitation.consumed_at)})
                                    {/if}
                                {:else if invitation.status === "revoked"}
                                    Revoked {invitation.revoked_at ? relativeTime(invitation.revoked_at) : ""}
                                {:else}
                                    Expired {relativeTime(invitation.expires_at)}
                                {/if}
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            {#if invitation.status === "claimable"}
                                <span class="badge badge-warning">Pending</span>
                                <button
                                    type="button"
                                    class="button button-quiet button-sm"
                                    disabled={busy}
                                    onclick={() =>
                                        run((g) => onRevokeInvitation(g, invitation.id))}
                                >
                                    Revoke
                                </button>
                            {:else if invitation.status === "claimed"}
                                <span class="badge badge-neutral">Claimed</span>
                            {:else if invitation.status === "revoked"}
                                <span class="badge badge-neutral">Revoked</span>
                            {:else}
                                <span class="badge badge-neutral">Expired</span>
                            {/if}
                        </div>
                    </div>
                {/each}
            {:else if grant.invitations.length > 0}
                {#each grant.invitations as invitation (invitation.id)}
                    <div class="subbox-row">
                        <div class="min-w-0">
                            <div class="text-xs font-medium">One-time link</div>
                            <div class="text-[11px] text-muted mt-0.5">
                                Expires {formattedUnixDateTime(invitation.expires_at)}
                            </div>
                        </div>
                        <button
                            type="button"
                            class="button button-quiet button-sm"
                            disabled={busy}
                            onclick={() =>
                                run((g) => onRevokeInvitation(g, invitation.id))}
                        >
                            Revoke
                        </button>
                    </div>
                {/each}
            {:else}
                <p class="text-xs text-muted py-1">No invitations recorded.</p>
            {/if}
        </div>
    </div>

    {#if dropCount > 0}
        <div class="drop-callout">
            <div class="min-w-0 text-xs">
                <strong>{dropCount} dropped {dropCount === 1 ? "attempt" : "attempts"} on this connection:</strong>
                {#if latestDrop}
                    <span class="ml-1">
                        <code>{latestDrop.reason_code}</code>
                        {#if latestDrop.client_public_key}
                            from client <code>{shortKey(latestDrop.client_public_key)}</code>
                        {/if}
                        ({relativeTime(latestDrop.occurred_at)})
                    </span>
                {:else}
                    <span class="ml-1">Check the signing log for details.</span>
                {/if}
            </div>
            {#if onInspectLog}
                <button
                    type="button"
                    class="button button-secondary button-sm"
                    onclick={() => onInspectLog(grant)}
                >
                    View trace →
                </button>
            {/if}
        </div>
    {/if}

    <details class="grant-tech-details">
        <summary>Connection details &amp; bunker identity</summary>
        <div class="grant-tech-body">
            <div class="flex items-center gap-2 flex-wrap">
                <span class="text-muted">Remote signer pubkey:</span>
                <code class="font-mono break-all select-all">{grant.remote_signer_public_key}</code>
                <Copy value={grant.remote_signer_public_key} size="13" label="Copy remote signer public key" />
            </div>
            <div class="flex flex-wrap gap-4 text-muted mt-2">
                <span>Created {formattedUnixDateTime(grant.created_at)}</span>
                <span>
                    {grant.expires_at
                        ? `Expires ${formattedUnixDateTime(grant.expires_at)}`
                        : "No expiration"}
                </span>
            </div>
        </div>
    </details>
</article>
