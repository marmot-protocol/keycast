<script lang="ts">
    import Copy from "#lib/components/Copy.svelte";
    import GrantEditor from "#lib/components/GrantEditor.svelte";
    import type {
        AuditEvent,
        Grant,
        GrantDiagnosticEvent,
        Policy,
        StoredKey,
    } from "#lib/types";
    import {
        grantState,
        grantStateLabel,
        policyCapabilityChips,
        relativeTime,
        shortKey,
    } from "#lib/utils/diagnostics";
    import { LinkSimple, Plus, Pulse } from "phosphor-svelte";

    let {
        teamId,
        keys,
        policies,
        grants,
        diagnostics = [],
        auditEvents = [],
        loading = false,
        error = "",
        invitationBanner = null,
        onDismissBanner,
        onOpenKey,
        onInspectGrant,
        onCreateInvitation,
        onRevokeGrant,
        onCreated,
    }: {
        teamId: string;
        keys: StoredKey[];
        policies: Policy[];
        grants: Grant[];
        diagnostics: GrantDiagnosticEvent[];
        auditEvents: AuditEvent[];
        loading?: boolean;
        error?: string;
        invitationBanner?: { grantName: string; uri: string } | null;
        onDismissBanner?: () => void;
        onOpenKey: (pubkey: string) => void;
        onInspectGrant: (grant: Grant) => void;
        onCreateInvitation: (grant: Grant) => Promise<void>;
        onRevokeGrant: (grant: Grant) => Promise<void>;
        onCreated: () => Promise<void>;
    } = $props();

    let statusFilter = $state<"active" | "connected" | "awaiting" | "issues" | "revoked">("active");
    let keyFilter = $state<string>("all");
    let creating = $state(false);
    let busyGrantId = $state<number | null>(null);

    const policyById = $derived(new Map(policies.map((p) => [p.id, p])));

    function grantDrops(grant: Grant): GrantDiagnosticEvent[] {
        return diagnostics.filter((d) => d.grant_id === grant.id);
    }

    function latestAuditForGrant(grant: Grant): AuditEvent | undefined {
        return auditEvents.find((e) => e.grant_id === grant.id);
    }

    function hasIssues(grant: Grant): boolean {
        if ((grant.recent_drops ?? 0) > 0 || grantDrops(grant).length > 0) return true;
        const latest = latestAuditForGrant(grant);
        return latest?.outcome === "denied" || latest?.outcome === "failed";
    }

    const keyScopedGrants = $derived(
        keyFilter === "all"
            ? grants
            : grants.filter((g) => String(g.stored_key_id) === keyFilter),
    );

    const activeCount = $derived(
        keyScopedGrants.filter((g) => {
            const status = grantState(g);
            return status !== "revoked" && status !== "expired";
        }).length,
    );

    const archivedCount = $derived(
        keyScopedGrants.filter((g) => {
            const status = grantState(g);
            return status === "revoked" || status === "expired";
        }).length,
    );

    const totalActiveCount = $derived(
        grants.filter((g) => {
            const status = grantState(g);
            return status !== "revoked" && status !== "expired";
        }).length,
    );

    const filteredGrants = $derived(
        keyScopedGrants.filter((grant) => {
            const status = grantState(grant);
            if (statusFilter === "active") return status !== "revoked" && status !== "expired";
            if (statusFilter === "connected") return status === "connected";
            if (statusFilter === "awaiting") return status === "awaiting_pairing";
            if (statusFilter === "issues") return hasIssues(grant);
            if (statusFilter === "revoked") return status === "revoked" || status === "expired";
            return true;
        }),
    );

    const issueCount = $derived(keyScopedGrants.filter((g) => hasIssues(g)).length);

    async function runGrantAction(grant: Grant, action: (g: Grant) => Promise<void>) {
        busyGrantId = grant.id;
        try {
            await action(grant);
        } finally {
            busyGrantId = null;
        }
    }
</script>

<section class="section !mt-0" aria-label="All connections">
    <div class="section-heading">
        <div>
            <h2>Connections <span>{totalActiveCount}</span></h2>
            <p class="description mt-1">
                Active NIP-46 app grants across all keys in this team. Revoked and expired connections are hidden by default.
            </p>
        </div>
        {#if keys.length > 0}
            <button
                type="button"
                class="button button-primary"
                aria-expanded={creating}
                onclick={() => (creating = !creating)}
            >
                <Plus size={14} />{creating ? "Close form" : "New connection"}
            </button>
        {/if}
    </div>

    {#if creating}
        <div class="form-panel">
            <GrantEditor
                id={teamId}
                availableKeys={keys}
                availablePolicies={policies}
                onDone={async () => {
                    creating = false;
                    await onCreated();
                }}
            />
        </div>
    {/if}

    {#if invitationBanner}
        <div class="invitation">
            <h3 class="text-sm font-semibold mb-1">
                One-time invitation for {invitationBanner.grantName}
            </h3>
            <p class="description mb-3">
                Copy this bunker URL now — Keycast only stores a hash of its secret. Clients pair once and keep their client key (for <code>nak</code>, use a persistent <code>--connect-as</code> / <code>NOSTR_CLIENT_KEY</code>).
            </p>
            <div class="font-mono text-xs break-all flex items-center gap-2 bg-canvas p-3 rounded-md border border-line">
                <span class="grow select-all">{invitationBanner.uri}</span>
                <Copy value={invitationBanner.uri} label="Copy bunker URI" />
            </div>
            {#if onDismissBanner}
                <button
                    type="button"
                    class="button button-secondary mt-3"
                    onclick={onDismissBanner}
                >
                    Dismiss
                </button>
            {/if}
        </div>
    {/if}

    <div class="log-toolbar mb-4">
        <div class="pill-group" role="group" aria-label="Connection status filter">
            <button
                type="button"
                class="filter-pill"
                class:active={statusFilter === "active"}
                onclick={() => (statusFilter = "active")}
            >
                Active ({activeCount})
            </button>
            <button
                type="button"
                class="filter-pill"
                class:active={statusFilter === "connected"}
                onclick={() => (statusFilter = "connected")}
            >
                Connected
            </button>
            <button
                type="button"
                class="filter-pill"
                class:active={statusFilter === "awaiting"}
                onclick={() => (statusFilter = "awaiting")}
            >
                Awaiting pairing
            </button>
            <button
                type="button"
                class="filter-pill"
                class:active={statusFilter === "issues"}
                onclick={() => (statusFilter = "issues")}
            >
                Issues {#if issueCount > 0}<span class="pill-count-danger">{issueCount}</span>{:else}(0){/if}
            </button>
            <button
                type="button"
                class="filter-pill"
                class:active={statusFilter === "revoked"}
                onclick={() => (statusFilter = "revoked")}
            >
                Revoked / Expired ({archivedCount})
            </button>
        </div>

        <select
            class="filter-select"
            aria-label="Filter by signing key"
            bind:value={keyFilter}
        >
            <option value="all">All keys ({keys.length})</option>
            {#each keys as key (key.id)}
                <option value={String(key.id)}>{key.name}</option>
            {/each}
        </select>
    </div>

    {#if error}
        <p class="input-error mb-3" role="alert">{error}</p>
    {/if}

    {#if !loading && filteredGrants.length === 0}
        <div class="empty-state">
            {#if grants.length === 0}
                No app connections yet. Import a key, create a policy, then click <strong>New connection</strong> to pair an app or CLI.
            {:else if statusFilter === "active" && archivedCount > 0}
                No active connections{keyFilter !== "all" ? " on this key" : ""}. Switch to
                <button
                    type="button"
                    class="bordered text-ink"
                    onclick={() => (statusFilter = "revoked")}
                >
                    Revoked / Expired ({archivedCount})
                </button>
                to inspect archived grants.
            {:else}
                No connections match the selected filter.
            {/if}
        </div>
    {:else}
        <div class="table-scroll border border-line bg-surface">
            <table class="data-table connections-table">
                <thead>
                    <tr>
                        <th>Connection (Grant)</th>
                        <th>Signing Key</th>
                        <th>Policy &amp; Capabilities</th>
                        <th>Sessions &amp; Invites</th>
                        <th>Health / Latest</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {#each filteredGrants as grant (grant.id)}
                        {@const status = grantState(grant)}
                        {@const policy = policyById.get(grant.policy_id)}
                        {@const chips = policyCapabilityChips(policy)}
                        {@const drops = grantDrops(grant)}
                        {@const dropCount = Math.max(grant.recent_drops ?? 0, drops.length)}
                        {@const latest = latestAuditForGrant(grant)}
                        {@const activeSessions = (grant.sessions ?? []).filter((s) => s.ended_at === null)}
                        <tr class:opacity-75={status === "revoked" || status === "expired"}>
                            <td>
                                <div class="font-semibold text-sm">{grant.name}</div>
                                <div class="font-mono text-[11px] text-muted mt-1">
                                    bunker {shortKey(grant.remote_signer_public_key)}
                                </div>
                            </td>
                            <td>
                                {#if grant.stored_key_public_key}
                                    <button
                                        type="button"
                                        class="text-left bordered text-xs font-medium"
                                        onclick={() => onOpenKey(grant.stored_key_public_key!)}
                                    >
                                        {grant.stored_key_name ?? shortKey(grant.stored_key_public_key)}
                                    </button>
                                {:else}
                                    <span class="text-xs">{grant.stored_key_name ?? `Key #${grant.stored_key_id}`}</span>
                                {/if}
                            </td>
                            <td>
                                <div class="text-xs font-medium mb-1">
                                    {policy?.name ?? grant.policy_name ?? `Policy #${grant.policy_id}`}
                                </div>
                                <div class="chip-list">
                                    {#each chips.slice(0, 5) as chip}
                                        <span class="kind-chip">{chip}</span>
                                    {/each}
                                    {#if chips.length > 5}
                                        <span class="text-[11px] text-muted">+{chips.length - 5} more</span>
                                    {/if}
                                </div>
                            </td>
                            <td>
                                <div class="flex flex-wrap gap-1.5 items-center mb-1">
                                    <span
                                        class="badge"
                                        class:badge-warning={status === "awaiting_pairing"}
                                        class:badge-neutral={status !== "connected" && status !== "awaiting_pairing"}
                                    >
                                        {grantStateLabel(status)}
                                    </span>
                                </div>
                                {#if activeSessions.length > 0}
                                    {#each activeSessions.slice(0, 2) as s (s.id)}
                                        <div class="font-mono text-[11px] text-muted">
                                            {shortKey(s.client_public_key)} · {relativeTime(s.last_seen_at)}
                                        </div>
                                    {/each}
                                {:else if grant.claimable_invitations > 0}
                                    <div class="text-[11px] text-muted">
                                        {grant.claimable_invitations} claimable {grant.claimable_invitations === 1 ? "invite" : "invites"}
                                    </div>
                                {/if}
                            </td>
                            <td>
                                {#if dropCount > 0}
                                    <span class="badge badge-danger">{dropCount} dropped</span>
                                    {#if drops[0]}
                                        <div class="font-mono text-[11px] text-muted mt-1">
                                            {drops[0].reason_code} · {relativeTime(drops[0].occurred_at)}
                                        </div>
                                    {/if}
                                {:else if latest}
                                    <span
                                        class="badge"
                                        class:badge-danger={latest.outcome === "denied" || latest.outcome === "failed"}
                                        class:badge-neutral={latest.outcome === "succeeded" && !latest.action.startsWith("nip46.")}
                                    >
                                        {latest.action}
                                    </span>
                                    <div class="text-[11px] text-muted mt-1">
                                        {latest.reason_code ?? latest.outcome} · {relativeTime(latest.occurred_at)}
                                    </div>
                                {:else}
                                    <span class="text-xs text-muted">No requests yet</span>
                                {/if}
                            </td>
                            <td>
                                <div class="flex flex-wrap gap-1.5">
                                    <button
                                        type="button"
                                        class="button button-secondary button-sm"
                                        onclick={() => onInspectGrant(grant)}
                                    >
                                        <Pulse size={13} /> Trace
                                    </button>
                                    {#if status !== "revoked" && status !== "expired"}
                                        <button
                                            type="button"
                                            class="button button-secondary button-sm"
                                            disabled={busyGrantId === grant.id}
                                            onclick={() => runGrantAction(grant, onCreateInvitation)}
                                        >
                                            <LinkSimple size={13} /> Invite
                                        </button>
                                    {/if}
                                    {#if !grant.revoked_at}
                                        <button
                                            type="button"
                                            class="button button-danger button-sm"
                                            disabled={busyGrantId === grant.id}
                                            onclick={() => runGrantAction(grant, onRevokeGrant)}
                                        >
                                            Revoke
                                        </button>
                                    {/if}
                                </div>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}
</section>
