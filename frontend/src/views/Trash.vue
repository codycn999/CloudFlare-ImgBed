<template>
    <div class="trash-page">
        <header><DashboardTabs activeTab="trash" /><el-button @click="$router.push('/dashboard')">{{ $t('trash.back') }}</el-button></header>
        <main>
            <div class="title-row"><div><h1>{{ $t('trash.title') }}</h1><p>{{ $t('trash.subtitle') }}</p></div><el-button :loading="loading" :disabled="busy" @click="load(true)">{{ $t('trash.refresh') }}</el-button></div>
            <el-alert :title="$t('trash.notice')" type="info" :closable="false" show-icon />
            <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="status" />
            <div class="toolbar"><el-input v-model="search" clearable :placeholder="$t('trash.search')" :aria-label="$t('trash.search')" /><span>{{ $t('trash.loaded', { count: files.length }) }}</span></div>
            <el-table v-loading="loading" :data="visibleFiles" row-key="id" :empty-text="$t('trash.empty')" class="trash-table">
                <el-table-column :label="$t('trash.name')" min-width="250"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="path">{{ row.path }}</div><el-tag v-if="row.kind === 'folder'" size="small">{{ $t('trash.folder') }}</el-tag><el-tag v-if="row.state === 'purging'" type="warning" size="small">{{ $t('trash.retryPurge') }}</el-tag></template></el-table-column>
                <el-table-column :label="$t('trash.channel')" prop="channel" width="150" />
                <el-table-column :label="$t('trash.deletedAt')" width="190"><template #default="{ row }">{{ new Date(row.deletedAt).toLocaleString() }}</template></el-table-column>
                <el-table-column :label="$t('trash.actions')" width="215" fixed="right"><template #default="{ row }"><el-button size="small" :disabled="busy || row.state !== 'deleted'" @click="act(row, 'restore')">{{ $t('trash.restore') }}</el-button><el-button size="small" type="danger" plain :disabled="busy" @click="act(row, 'purge')">{{ $t('trash.purge') }}</el-button></template></el-table-column>
            </el-table>
            <div v-if="cursor" class="more"><el-button :loading="loading" :disabled="busy" @click="load(false)">{{ $t('trash.more') }}</el-button></div>
        </main>
    </div>
</template>

<script>
import DashboardTabs from '@/components/DashboardTabs.vue';
import axios from '@/utils/axios';
export default {
    name: 'TrashView',
    components: { DashboardTabs },
    data: () => ({ files: [], cursor: null, loading: false, busy: false, search: '', error: '' }),
    computed: { visibleFiles() { const q = this.search.trim().toLowerCase(); return this.files.filter(f => f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)); } },
    mounted() { this.load(true); },
    methods: {
        async load(reset) {
            if (this.loading) return;
            this.loading = true; this.error = '';
            try {
                const { data } = await axios.get('/api/manage/trash', { params: reset ? {} : { cursor: this.cursor } });
                if (!data.success) throw new Error(data.error);
                this.files = reset ? data.files : [...new Map([...this.files, ...data.files].map(f => [f.id, f])).values()];
                this.cursor = data.cursor;
            } catch (e) { this.error = e.response?.data?.error || e.message || this.$t('trash.failed'); }
            finally { this.loading = false; }
        },
        async act(row, action) {
            const purge = action === 'purge';
            try { await this.$confirm(this.$t(purge ? 'trash.purgeConfirm' : 'trash.restoreConfirm', { path: row.path }), this.$t(purge ? 'trash.purge' : 'trash.restore'), { type: purge ? 'warning' : 'info', confirmButtonText: this.$t(purge ? 'trash.purge' : 'trash.restore'), cancelButtonText: this.$t('dashboard.deleteConfirmCancel') }); }
            catch { return; }
            this.busy = true;
            try {
                const endpoint = '/api/manage/trash/' + encodeURIComponent(row.id);
                const { data } = purge ? await axios.delete(endpoint) : await axios.post(endpoint + '/restore');
                if (!data.success) throw new Error(data.error);
                if (data.warning) this.$message.warning(data.warning);
                else this.$message.success(this.$t(purge ? 'trash.purged' : 'trash.restored'));
                this.files = this.files.filter(f => f.id !== row.id);
            } catch (e) { this.$message.error(e.response?.data?.error || e.message || this.$t('trash.failed')); await this.load(true); }
            finally { this.busy = false; }
        }
    }
};
</script>

<style scoped>
.trash-page { min-height: 100vh; text-align: left; background: var(--el-bg-color-page); color: var(--el-text-color-primary); }
header { padding: 18px 28px; display: flex; justify-content: space-between; align-items: center; background: var(--el-bg-color); border-bottom: 1px solid var(--el-border-color-lighter); }
main { max-width: 1220px; padding: 32px 28px 60px; margin: auto; }
.title-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
h1 { margin: 0 0 10px; font-size: 28px; } p, .path, .toolbar span { color: var(--el-text-color-secondary); }
p { line-height: 1.6; margin: 0 0 22px; } .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 24px 0 16px; }
.toolbar .el-input { max-width: 360px; } .toolbar span { white-space: nowrap; font-size: 13px; } .path { font-size: 12px; overflow-wrap: anywhere; margin-top: 4px; }
.trash-table { border: 1px solid var(--el-border-color-lighter); border-radius: 10px; } .more { text-align: center; margin-top: 20px; } .status { margin-top: 12px; }
@media (max-width: 600px) { header { padding: 14px 12px; gap: 8px; } main { padding: 24px 12px; } h1 { font-size: 24px; } .toolbar { gap: 10px; } }
</style>
