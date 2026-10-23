<template>
    <div class="token-permissions">
        <el-checkbox-group :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
            <div v-for="option in options" :key="option.value" class="permission-option">
                <el-checkbox :label="option.value">{{ $t('sysSecurity.' + option.label) }}</el-checkbox>
                <p>{{ $t('sysSecurity.' + option.label + 'Hint') }}</p>
            </div>
        </el-checkbox-group>
        <p class="permission-combination">{{ $t('sysSecurity.permissionCombination') }}</p>
    </div>
</template>

<script>
export default {
    props: { modelValue: { type: Array, default: () => [] } },
    emits: ['update:modelValue'],
    data() {
        return { options: [
            { value: 'list', label: 'permList' },
            { value: 'organize', label: 'permOrganize' },
            { value: 'replace', label: 'permReplace' },
            { value: 'delete', label: 'permDelete' },
            { value: 'purge', label: 'permPurge' },
            { value: 'upload', label: 'permUpload' },
            { value: 'manage', label: 'permManage' }
        ] };
    }
};
</script>

<style scoped>
.token-permissions { width: 100%; text-align: left; }
.permission-option { padding: 0 0 5px; }
.permission-option p { margin: 0 0 0 24px; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.permission-combination { margin: 6px 0 0; padding: 8px 10px; border-radius: 6px; background: var(--el-fill-color-light); color: var(--el-text-color-regular); font-size: 12px; line-height: 1.6; }
</style>
