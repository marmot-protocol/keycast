<script lang="ts">
    import { page } from "$app/state";
    import TeamDirectory from "#lib/components/TeamDirectory.svelte";
</script>

<TeamDirectory teamId={page.params.id} />
