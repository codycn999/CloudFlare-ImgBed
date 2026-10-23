export function quickUploadSettings(getters, channels = {}) {
    const config = getters.userConfig || {}
    const compress = getters.compressConfig || {}
    const boolean = (value, fallback) => value == null ? fallback : value === true || value === 'true'
    const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
    const uploadChannel = getters.storeUploadChannel || config.defaultUploadChannel || 'telegram'
    const savedName = getters.storeChannelName
    const preferredName = savedName == null ? config.defaultChannelName : savedName
    const channelName = (channels[uploadChannel] || []).some(channel => channel.name === preferredName) ? preferredName : ''
    return {
        uploadChannel, channelName,
        customerCompress: compress.customerCompress ?? boolean(config.defaultCustomerCompress, true),
        compressQuality: compress.compressQuality ?? number(config.defaultCompressQuality, 4),
        compressBar: compress.compressBar ?? number(config.defaultCompressBar, 5),
        serverCompress: compress.serverCompress ?? true,
        convertToWebp: compress.convertToWebp ?? boolean(config.defaultConvertToWebp, false),
        autoRetry: getters.storeAutoRetry ?? true,
        uploadNameType: 'default'
    }
}
