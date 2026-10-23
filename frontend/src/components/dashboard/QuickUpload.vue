<template>
    <UploadForm compact v-bind="settings" :disabled="!ready" :upload-folder="uploadFolder"
        :title="$t('dashboard.quickUploadFolder', { folder: currentPath || '/' })"
        @select="captureDestination" @uploaded="$emit('uploaded')" />
</template>

<script>
import UploadForm from '@/components/upload/UploadForm.vue'
import axios from '@/utils/axios'
import { quickUploadSettings } from '@/utils/upload/quickUploadSettings'

export default {
    name: 'QuickUpload',
    components: { UploadForm },
    emits: ['uploaded'],
    props: { currentPath: { type: String, default: '' } },
    data() {
        return { ready: false, channels: {}, settings: quickUploadSettings(this.$store.getters), uploadFolder: '' }
    },
    async mounted() {
        try {
            const response = await axios.get('/api/channels', { withAuthCode: true })
            this.channels = response.data || {}
        } catch (error) {
            // An unspecified channel name lets the server choose an available channel.
            console.warn('Could not load quick upload channel names', error.message)
        } finally {
            this.settings = quickUploadSettings(this.$store.getters, this.channels)
            this.ready = true
        }
    },
    methods: {
        captureDestination() {
            this.uploadFolder = this.currentPath
            this.settings = quickUploadSettings(this.$store.getters, this.channels)
        }
    }
}
</script>
