/**
 * 插件配置 schema。
 *
 * 配置来源有两层：
 *  1. **组合层（composition）** —— `cordis.patch.yml` 里插件行的字段，
 *     由 cordis 按本文件的 {@link Config} schema 解析后作为 `apply(ctx, config)` 的入参；
 *  2. **默认值** —— 本文件的 {@link DEFAULT_CONFIG}。
 *
 * 注意：本插件**不使用** settings 文件里的用户层配置（网关自身的 config.json
 * 才是权威）。这里注册的 settings namespace 只为让模型设置页有合法的
 * `settingsNs` 地址，避免 `deriveKeyRef(provider)` 崩溃，见 `index.ts`。
 *
 * @module dsh-plugin-wb2api-ui/gw/config
 */
import Schema from '@deepseek-ai/schemastery';
/** provider 路由 id。**永久不可改** —— 会话历史、请求日志、凭据引用都以它为主键。 */
export const PROVIDER = 'workbuddy2api';
/** 插件自身的 settings namespace（同时也是 provider 的 settingsNs）。 */
export const SETTINGS_NS = 'llm-workbuddy2api';
export const DEFAULT_CONFIG = {
    baseURL: 'http://127.0.0.1:7863/v1',
    apiKeyRef: 'WORKBUDDY2API_API_KEY',
    binaryPath: '',
    repoPath: '',
    workingDir: '',
    listenPort: 7863,
    autoStart: true,
    realmPrefixPolicy: 'strip-cn',
    modelsTtlSeconds: 600,
    requestTimeoutSeconds: 600,
    idleTimeoutSeconds: 300,
    firstTokenTimeoutSeconds: 120,
    healthTimeoutSeconds: 3,
    graceMs: 5000,
    crashRestartLimit: 3,
    env: {},
    // 本仓库自带的二进制在 backend/bin/（随包发布），下载只是兜底；把下载源指到本仓库。
    binaryReleaseRepo: 'Wei894348/dsh-wb2api',
    binaryReleaseBase: '',
    autoDownloadBinary: false,
    defaultRealm: '',
};
/**
 * schemastery 配置 schema。
 *
 * **必须**用 `Schema.object({...})` 构造 —— `settings.describe()` 会对每个注册项
 * 无条件调用 `schema.toJSON()`，传裸函数会抛
 * `TypeError: registration.schema.toJSON is not a function`，
 * 连带让模型设置页、主题、sidebar 的 settings API 全部失效。
 */
export const Config = Schema.object({
    baseURL: Schema.string().default(DEFAULT_CONFIG.baseURL),
    apiKeyRef: Schema.string().default(DEFAULT_CONFIG.apiKeyRef),
    binaryPath: Schema.string().default(DEFAULT_CONFIG.binaryPath),
    repoPath: Schema.string().default(DEFAULT_CONFIG.repoPath),
    workingDir: Schema.string().default(DEFAULT_CONFIG.workingDir),
    listenPort: Schema.natural().default(DEFAULT_CONFIG.listenPort),
    autoStart: Schema.boolean().default(DEFAULT_CONFIG.autoStart),
    realmPrefixPolicy: Schema.union([
        Schema.const('strip-cn'),
        Schema.const('keep'),
    ]).default(DEFAULT_CONFIG.realmPrefixPolicy),
    modelsTtlSeconds: Schema.natural().default(DEFAULT_CONFIG.modelsTtlSeconds),
    requestTimeoutSeconds: Schema.natural().default(DEFAULT_CONFIG.requestTimeoutSeconds),
    idleTimeoutSeconds: Schema.natural().default(DEFAULT_CONFIG.idleTimeoutSeconds),
    firstTokenTimeoutSeconds: Schema.natural().default(DEFAULT_CONFIG.firstTokenTimeoutSeconds),
    healthTimeoutSeconds: Schema.natural().default(DEFAULT_CONFIG.healthTimeoutSeconds),
    graceMs: Schema.natural().default(DEFAULT_CONFIG.graceMs),
    crashRestartLimit: Schema.natural().default(DEFAULT_CONFIG.crashRestartLimit),
    env: Schema.dict(Schema.string()).default({}),
    binaryReleaseRepo: Schema.string().default(DEFAULT_CONFIG.binaryReleaseRepo),
    binaryReleaseBase: Schema.string().default(DEFAULT_CONFIG.binaryReleaseBase),
    autoDownloadBinary: Schema.boolean().default(DEFAULT_CONFIG.autoDownloadBinary),
    defaultRealm: Schema.string().default(DEFAULT_CONFIG.defaultRealm),
});
/**
 * 把组合层传入的原始配置合并到默认值之上。
 *
 * `apply(ctx, config)` 在插件行未声明任何字段时可能收到 `undefined` 或 `{}`，
 * 因此这里做一次显式归一化，避免下游到处判空。
 *
 * @param raw - cordis 传入的已解析配置（可能不完整）。
 * @returns 字段齐全的配置对象。
 */
export function resolveConfig(raw) {
    const merged = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
    // env 是字典型字段：默认值必须与用户值合并，而不是被整体覆盖成 undefined。
    merged.env = { ...DEFAULT_CONFIG.env, ...(raw?.env ?? {}) };
    if (merged.realmPrefixPolicy !== 'keep')
        merged.realmPrefixPolicy = 'strip-cn';
    if (!Number.isFinite(merged.listenPort) || merged.listenPort <= 0)
        merged.listenPort = DEFAULT_CONFIG.listenPort;
    // defaultRealm 只认两个合法值；其余（含默认空串）归一为「未指定」，由命令层询问用户。
    if (merged.defaultRealm !== 'cn' && merged.defaultRealm !== 'global')
        merged.defaultRealm = '';
    return merged;
}
/** 由 baseURL 推导同源的根地址（剥掉结尾的 `/v1`），用于打 `/healthz`。 */
export function gatewayOrigin(baseURL) {
    const trimmed = baseURL.replace(/\/+$/, '');
    return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}
/** 由 baseURL 推导端口；解析失败时回退配置里的 listenPort。 */
export function gatewayPort(baseURL, fallback) {
    try {
        const url = new URL(baseURL);
        if (url.port !== '')
            return Number(url.port);
        return url.protocol === 'https:' ? 443 : 80;
    }
    catch {
        return fallback;
    }
}
//# sourceMappingURL=config.js.map