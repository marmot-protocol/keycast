<script lang="ts">
    import Copy from "#lib/components/Copy.svelte";
    import type {
        AuditEvent,
        Grant,
        GrantDiagnosticEvent,
        Policy,
        StoredKey,
    } from "#lib/types";
    import {
        grantState,
        mergeTrace,
        relativeTime,
        shortKey,
        type TraceEntry,
    } from "#lib/utils/diagnostics";
    import { formattedUnixDateTime } from "#lib/utils/dates";
    import { ArrowClockwise } from "phosphor-svelte";

    let {
        auditEvents = [],
        diagnostics = [],
        keys = [],
        grants = [],
        policies = [],
        lockedKeyId = null,
        initialGrantId = null,
        loading = false,
        error = "",
        onRefresh,
        onEditPolicy,
    }: {
        auditEvents: AuditEvent[];
        diagnostics: GrantDiagnosticEvent[];
        keys: StoredKey[];
        grants: Grant[];
        policies: Policy[];
        lockedKeyId?: number | null;
        initialGrantId?: number | null;
        loading?: boolean;
        error?: string;
        onRefresh?: () => void | Promise<void>;
        onEditPolicy?: (policyId: number) => void;
    } = $props();

    let selectedKeyId = $state<string>("all");
    let selectedGrantId = $state<string>("all");
    let outcomeFilter = $state<"all" | "problems" | "allowed" | "management">("all");
    let clientQuery = $state("");

    $effect(() => {
        if (lockedKeyId !== null) {
            selectedKeyId = String(lockedKeyId);
        }
    });

    $effect(() => {
        if (initialGrantId !== null) {
            selectedGrantId = String(initialGrantId);
        }
    });

    const visibleGrants = $derived.by(() => {
        const scoped =
            selectedKeyId === "all"
                ? grants
                : grants.filter((g) => String(g.stored_key_id) === selectedKeyId);
        return [...scoped].sort((a, b) => {
            const aArchived = grantState(a) === "revoked" || grantState(a) === "expired" ? 1 : 0;
            const bArchived = grantState(b) === "revoked" || grantState(b) === "expired" ? 1 : 0;
            if (aArchived !== bArchived) return aArchived - bArchived;
            return b.created_at - a.created_at;
        });
    });

    const allEntries = $derived(
        mergeTrace(auditEvents, diagnostics, { keys, grants, policies }),
    );

    const scopedEntries = $derived.by(() => {
        return allEntries.filter((entry) => {
            if (lockedKeyId !== null && entry.stored_key_id !== lockedKeyId) {
                return false;
            }
            if (
                lockedKeyId === null &&
                selectedKeyId !== "all" &&
                String(entry.stored_key_id) !== selectedKeyId
            ) {
                return false;
            }
            if (
                selectedGrantId !== "all" &&
                String(entry.grant_id) !== selectedGrantId
            ) {
                return false;
            }
            return true;
        });
    });

    const problemCount = $derived(
        scopedEntries.filter(
            (e) => e.severity === "err" || e.severity === "warn",
        ).length,
    );

    const filteredEntries = $derived.by(() => {
        const needle = clientQuery.trim().toLowerCase();
        return scopedEntries.filter((entry) => {
            if (outcomeFilter === "problems") {
                if (entry.severity !== "err" && entry.severity !== "warn")
                    return false;
            } else if (outcomeFilter === "allowed") {
                if (entry.severity !== "ok") return false;
            } else if (outcomeFilter === "management") {
                if (entry.category !== "management") return false;
            }
            if (needle) {
                const hay = [
                    entry.client_public_key ?? "",
                    entry.action,
                    entry.reason_code ?? "",
                    entry.grant_name ?? "",
                    entry.stored_key_name ?? "",
                    entry.summary,
                    entry.requested_kind !== null ? `kind ${entry.requested_kind}` : "",
                ]
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(needle)) return false;
            }
            return true;
        });
    });

    function badgeClass(entry: TraceEntry): string {
        if (entry.severity === "err") return "badge badge-danger";
        if (entry.severity === "warn") return "badge badge-warning";
        if (entry.severity === "ok") return "badge";
        return "badge badge-neutral";
    }
</script>

<div class="log-shell">
    <div class="log-toolbar">
        <div class="log-filters">
            {#if lockedKeyId === null}
                <label class="sr-only" for="trace-key-filter">Filter by key</label>
                <select
                    id="trace-key-filter"
                    class="filter-select"
                    bind:value={selectedKeyId}
                    onchange={() => (selectedGrantId = "all")}
                >
                    <option value="all">All keys ({keys.length})</option>
                    {#each keys as key (key.id)}
                        <option value={String(key.id)}>{key.name}</option>
                    {/each}
                </select>
            {/if}

            <label class="sr-only" for="trace-grant-filter">Filter by connection</label>
            <select
                id="trace-grant-filter"
                class="filter-select"
                bind:value={selectedGrantId}
            >
                <option value="all">All connections ({visibleGrants.length})</option>
                {#each visibleGrants as grant (grant.id)}
                    {@const status = grantState(grant)}
                    <option value={String(grant.id)}>
                        {grant.name}{status === "revoked" ? " (revoked)" : status === "expired" ? " (expired)" : ""}
                    </option>
                {/each}
            </select>

            <label class="sr-only" for="trace-search">Search client or reason</label>
            <input
                id="trace-search"
                type="search"
                class="filter-input"
                placeholder="Filter by client pubkey, kind, reason…"
                bind:value={clientQuery}
            />
        </div>

        <div class="log-toolbar-right">
            <div class="pill-group" role="group" aria-label="Outcome filter">
                <button
                    type="button"
                    class="filter-pill"
                    class:active={outcomeFilter === "all"}
                    onclick={() => (outcomeFilter = "all")}
                >
                    All ({scopedEntries.length})
                </button>
                <button
                    type="button"
                    class="filter-pill"
                    class:active={outcomeFilter === "problems"}
                    onclick={() => (outcomeFilter = "problems")}
                >
                    Problems {#if problemCount > 0}<span class="pill-count-danger">{problemCount}</span>{:else}(0){/if}
                </button>
                <button
                    type="button"
                    class="filter-pill"
                    class:active={outcomeFilter === "allowed"}
                    onclick={() => (outcomeFilter = "allowed")}
                >
                    Allowed
                </button>
                <button
                    type="button"
                    class="filter-pill"
                    class:active={outcomeFilter === "management"}
                    onclick={() => (outcomeFilter = "management")}
                >
                    Admin
                </button>
            </div>

            {#if onRefresh}
                <button
                    type="button"
                    class="button button-secondary"
                    disabled={loading}
                    onclick={onRefresh}
                >
                    <ArrowClockwise size={14} />
                    <span>{loading ? "Loading…" : "Refresh"}</span>
                </button>
            {/if}
        </div>
    </div>

    {#if error}
        <p class="input-error mb-3" role="alert">{error}</p>
    {/if}

    {#if !loading && filteredEntries.length === 0}
        <div class="empty-state">
            {#if scopedEntries.length === 0}
                No signing requests, connection attempts, or dropped NIP-46 envelopes recorded yet.
                When a client connects or sends a request over a configured relay, every allowed request,
                policy denial, and pre-admission drop will appear here.
            {:else}
                No log entries match the active filters.
            {/if}
        </div>
    {:else}
        <div class="trace-list">
            {#each filteredEntries as entry (entry.uid)}
                <article
                    class="trace-row"
                    class:trace-err={entry.severity === "err"}
                    class:trace-warn={entry.severity === "warn"}
                    class:trace-ok={entry.severity === "ok"}
                >
                    <div class="trace-head">
                        <div class="trace-badges">
                            <span class={badgeClass(entry)}>{entry.badge}</span>
                            <span class="font-mono text-xs font-semibold">{entry.action}</span>
                            {#if entry.requested_kind !== null}
                                <span class="kind-chip">
                                    kind {entry.requested_kind}{#if entry.requested_kind_name} · {entry.requested_kind_name}{/if}
                                </span>
                            {/if}
                            {#if entry.reason_code}
                                <span class="badge badge-neutral">{entry.reason_code}</span>
                            {/if}
                            {#if entry.grant_name}
                                <span class="trace-scope">
                                    {#if lockedKeyId === null && entry.stored_key_name}
                                        <span>{entry.stored_key_name}</span>
                                        <span class="opacity-60" aria-hidden="true">→</span>
                                    {/if}
                                    <span>{entry.grant_name}</span>
                                </span>
                            {:else if lockedKeyId === null && entry.stored_key_name}
                                <span class="trace-scope">{entry.stored_key_name}</span>
                            {/if}
                        </div>
                        <span
                            class="font-mono text-[11px] text-muted whitespace-nowrap"
                            title={formattedUnixDateTime(entry.occurred_at)}
                        >
                            {relativeTime(entry.occurred_at)} · {formattedUnixDateTime(entry.occurred_at)}
                        </span>
                    </div>

                    <p class="trace-summary">{entry.summary}</p>

                    {#if entry.hint}
                        <div class="trace-hint">
                            <span class="grow">{entry.hint}</span>
                            {#if entry.reason_code === "policy_denied" && entry.policy_id !== null && onEditPolicy}
                                <button
                                    type="button"
                                    class="button button-secondary button-sm"
                                    onclick={() => onEditPolicy(entry.policy_id!)}
                                >
                                    Edit policy
                                </button>
                            {/if}
                        </div>
                    {/if}

                    <div class="trace-meta">
                        {#if entry.client_public_key}
                            <span class="trace-meta-item">
                                <span>{entry.category === "management" ? "Actor:" : "Client:"}</span>
                                <code class="font-mono">{shortKey(entry.client_public_key)}</code>
                                <Copy value={entry.client_public_key} size="13" label={entry.category === "management" ? "Copy actor public key" : "Copy client public key"} />
                            </span>
                        {/if}
                        {#if entry.session_id !== null}
                            <span class="trace-meta-item">Session #{entry.session_id}</span>
                        {/if}
                        {#if entry.relay_in}
                            <span class="trace-meta-item">Relay in: <code>{entry.relay_in}</code></span>
                        {/if}
                        {#if entry.event_id}
                            <span class="trace-meta-item">Event: <code>{shortKey(entry.event_id)}</code></span>
                        {/if}
                        {#if entry.source === "diagnostic"}
                            <span class="trace-meta-item">In-memory drop trace (unauthenticated)</span>
                        {/if}
                    </div>
                </article>
            {/each}
        </div>
    {/if}
</div>
