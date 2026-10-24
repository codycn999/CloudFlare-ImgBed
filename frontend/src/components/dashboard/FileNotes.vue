<template>
    <section class="file-notes" v-loading="loading">
        <div class="notes-heading"><h3>{{ $t('fileNotes.title') }}</h3><span v-if="updatedAt">{{ $t('fileNotes.updated') }} {{ new Date(updatedAt).toLocaleString() }}</span></div>
        <p class="notes-help">{{ $t('fileNotes.help') }}</p>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <el-input v-model="draft" type="textarea" :rows="7" :maxlength="limit" show-word-limit :disabled="!loaded || saving" :placeholder="$t('fileNotes.placeholder')" :aria-label="$t('fileNotes.title')" />
        <div class="notes-footer">
            <span>{{ $t(dirty ? 'fileNotes.unsaved' : 'fileNotes.private') }}</span>
            <div><el-button :disabled="loading || saving" @click="reload">{{ $t('fileNotes.reload') }}</el-button><el-button type="primary" :loading="saving" :disabled="!loaded || !dirty || loading" @click="save">{{ $t('fileNotes.save') }}</el-button></div>
        </div>
    </section>
</template>

<script>
import fetchWithAuth from '@/utils/fetchWithAuth';
import { ElMessage, ElMessageBox } from 'element-plus';
export default {
    name: 'FileNotes',
    props: { fileKey: { type: String, required: true } },
    data: () => ({ draft: '', saved: '', revision: '', updatedAt: null, limit: 32768, loaded: false, loading: false, saving: false, error: '' }),
    computed: {
        dirty() { return this.loaded && this.draft !== this.saved; },
        endpoint() { return '/api/manage/notes/' + this.fileKey.split('/').map(encodeURIComponent).join('/'); }
    },
    mounted() { this.load(); },
    methods: {
        async load() {
            if (this.loading || this.saving) return;
            this.loading = true; this.error = '';
            try {
                const response = await fetchWithAuth(this.endpoint);
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || this.$t('fileNotes.loadFailed'));
                this.draft = this.saved = data.notes;
                this.revision = data.revision; this.updatedAt = data.updatedAt; this.limit = data.maxLength;
                this.loaded = true;
            } catch { this.error = this.$t('fileNotes.loadFailed'); }
            finally { this.loading = false; }
        },
        async confirmDiscard() {
            if (!this.dirty) return true;
            try { await ElMessageBox.confirm(this.$t('fileNotes.discard'), this.$t('fileNotes.title'), { type: 'warning', confirmButtonText: this.$t('fileNotes.discardOk'), cancelButtonText: this.$t('fileDetail.cancel') }); return true; }
            catch { return false; }
        },
        async reload() { if (await this.confirmDiscard()) await this.load(); },
        async save() {
            if (this.loading || this.saving || !this.loaded || !this.dirty) return;
            this.saving = true; this.error = '';
            const notes = this.draft;
            try {
                const response = await fetchWithAuth(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes, expectedRevision: this.revision }) });
                const data = await response.json();
                if (!response.ok || !data.success) { this.error = this.$t(response.status === 409 ? 'fileNotes.conflict' : 'fileNotes.saveFailed'); return; }
                this.saved = data.notes; this.revision = data.revision; this.updatedAt = data.updatedAt;
                ElMessage.success(this.$t('fileNotes.saved'));
            } catch { this.error = this.$t('fileNotes.saveFailed'); }
            finally { this.saving = false; }
        }
    }
};
</script>

<style scoped>
.file-notes { margin-top: 20px; text-align: left; border-top: 1px solid var(--el-border-color-lighter); padding-top: 16px; }
.notes-heading, .notes-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
h3 { margin: 0; font-size: 16px; } .notes-help, .notes-heading span, .notes-footer > span { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.notes-help { margin: 8px 0 12px; } .notes-footer { margin-top: 12px; } .el-alert { margin-bottom: 12px; }
:deep(textarea) { line-height: 1.65; }
</style>
