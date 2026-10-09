import * as nodeFs from 'node:fs';
import path from 'node:path';

/**
 * 网关把 auth 目录当成账号清单：只扫描可见的凭证文件。
 *
 * 禁用账号时只给文件追加后缀，不能删除。这样既保留刷新令牌，也让恢复账号成为
 * 可逆的 rename；真正删除只允许走 remove()，由上层绑定到用户的显式删除操作。
 *
 * 切换账号的调用顺序必须是「停网关 → 改名 → 启网关」。网关运行时持有原路径，
 * token 刷新可能把旧路径重新写出来；先停进程才能保证文件状态不会被后台写回。
 */

export const DISABLED_SUFFIX = '.disabled';

const FILE_PATTERN = /^workbuddy(?:[-_])?(.+)\.json(\.disabled)?$/;

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareAccounts(left, right) {
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  const byUid = compareText(left.uid, right.uid);
  return byUid !== 0 ? byUid : compareText(left.fileName, right.fileName);
}

function candidateLines(accounts) {
  if (accounts.length === 0) return '（无可用候选）';
  return accounts
    .map((account, index) => {
      const nickname = typeof account.nickname === 'string' && account.nickname !== ''
        ? ` (${account.nickname})`
        : '';
      return `${index + 1}. ${account.uid}${nickname}`;
    })
    .join('\n');
}

function asNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOptionalFields(document) {
  const account = document.account ?? {};
  const auth = document.auth ?? {};
  const nickname = asNonEmptyString(account.nickname);
  const realm = asNonEmptyString(auth.realm);
  const expiresAt = Number.isFinite(auth.expiresAt) ? auth.expiresAt : undefined;

  return {
    ...(nickname === undefined ? {} : { nickname }),
    ...(realm === undefined ? {} : { realm }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * auth 目录的同步视图。
 *
 * 这里使用同步 fs API 是有意的：目录通常只有几个小 JSON，调用方需要在停网关后的
 * 临界区内立即完成检查与 rename，避免在多个 await 之间让状态发生漂移。
 */
export class CredentialStore {
  constructor({ authDir, fs = nodeFs }) {
    if (typeof authDir !== 'string' || authDir.trim() === '') {
      throw new TypeError('authDir 必须是非空路径');
    }
    this.root = path.resolve(authDir);
    this.fs = fs;
  }

  /**
   * 从文件名读取 uid 和启用状态，不访问磁盘。
   */
  parseFile(fileName) {
    if (typeof fileName !== 'string') {
      throw new TypeError('凭证文件名必须是字符串');
    }
    const match = FILE_PATTERN.exec(fileName);
    if (match === null || match[1] === '') {
      throw new Error(`不是有效的 WorkBuddy 凭证文件名: ${fileName}`);
    }
    return {
      uid: match[1],
      enabled: match[2] === undefined,
    };
  }

  /**
   * 把受控文件名转换为绝对路径。
   *
   * 先拒绝显式穿越片段和两种平台的分隔符，再校验 resolve 后的父目录。两层检查
   * 同时覆盖 Windows 与 POSIX，也不会因进程运行平台不同而漏过反斜杠输入。
   */
  pathOf(fileName) {
    if (typeof fileName !== 'string' || fileName === '') {
      throw new TypeError('fileName 必须是非空字符串');
    }
    if (
      fileName.includes('..')
      || fileName.includes('/')
      || fileName.includes('\\')
      || fileName.includes('\0')
      || path.isAbsolute(fileName)
    ) {
      throw new Error(`拒绝 authDir 之外的路径: ${fileName}`);
    }

    const resolved = path.resolve(this.root, fileName);
    if (path.dirname(resolved) !== this.root) {
      throw new Error(`凭证路径越界: ${fileName}`);
    }
    return resolved;
  }

  /**
   * 扫描并解析全部启用、禁用凭证。
   */
  list() {
    let entries;
    try {
      entries = this.fs.readdirSync(this.root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }

    const accounts = [];
    for (const entry of entries) {
      const fileName = typeof entry === 'string' ? entry : entry.name;
      if (typeof entry !== 'string' && !entry.isFile()) continue;
      if (!FILE_PATTERN.test(fileName)) continue;

      const fileState = this.parseFile(fileName);
      const filePath = this.pathOf(fileName);
      let document;
      try {
        document = JSON.parse(this.fs.readFileSync(filePath, 'utf8'));
      } catch (error) {
        throw new Error(`无法解析凭证 ${fileName}: ${error.message}`, { cause: error });
      }

      const uid = asNonEmptyString(document?.account?.uid);
      if (uid === undefined) {
        throw new Error(`凭证 ${fileName} 缺少 account.uid`);
      }

      accounts.push({
        uid,
        fileName,
        path: filePath,
        enabled: fileState.enabled,
        ...readOptionalFields(document),
        disabled: !fileState.enabled,
      });
    }

    return accounts.sort(compareAccounts);
  }

  /**
   * 切换一个文件的可见性；状态未变化时保持幂等。
   */
  setEnabled(fileName, enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('enabled 必须是布尔值');
    }
    const current = this.parseFile(fileName);
    const source = this.pathOf(fileName);
    if (current.enabled === enabled) return { from: source, to: source };

    const targetName = enabled
      ? fileName.slice(0, -DISABLED_SUFFIX.length)
      : `${fileName}${DISABLED_SUFFIX}`;
    const target = this.pathOf(targetName);
    if (this.fs.existsSync(target)) {
      throw new Error(`目标凭证已存在，拒绝覆盖: ${targetName}`);
    }

    this.fs.renameSync(source, target);
    return { from: source, to: target };
  }

  /**
   * 真正删除凭证。上层只能在用户明确选择“删除账号”时调用。
   */
  remove(fileName) {
    this.parseFile(fileName);
    const target = this.pathOf(fileName);
    this.fs.unlinkSync(target);
    return target;
  }

  /**
   * 计算账号选择对应的 rename，不执行任何写操作。
   *
   * 计划与执行分开后，上层可以先停网关、再次校验计划，再逐项 setEnabled；也能在
   * 发现重复 uid 或文件冲突时保持目录完全不变。
   */
  applySelection(uids) {
    if (!Array.isArray(uids) || uids.some((uid) => typeof uid !== 'string')) {
      throw new TypeError('uids 必须是字符串数组');
    }

    const accounts = this.list();
    const grouped = new Map();
    for (const account of accounts) {
      const group = grouped.get(account.uid) ?? [];
      group.push(account);
      grouped.set(account.uid, group);
    }

    const duplicated = [...grouped]
      .filter(([, group]) => group.length > 1)
      .map(([uid, group]) => `${uid}: ${group.map((item) => item.fileName).join(', ')}`);
    if (duplicated.length > 0) {
      throw new Error(`同一 uid 存在多份凭证，请先清理:\n${duplicated.join('\n')}`);
    }

    const wanted = new Set(uids);
    const unknown = [...wanted].filter((uid) => !grouped.has(uid));
    if (unknown.length > 0) {
      throw new Error(`选择中包含不存在的 uid: ${unknown.join(', ')}`);
    }

    const plan = [];
    for (const account of accounts) {
      const shouldEnable = wanted.has(account.uid);
      if (account.enabled === shouldEnable) continue;

      const targetName = shouldEnable
        ? account.fileName.slice(0, -DISABLED_SUFFIX.length)
        : `${account.fileName}${DISABLED_SUFFIX}`;
      const target = this.pathOf(targetName);
      if (this.fs.existsSync(target)) {
        throw new Error(`目标凭证已存在，拒绝覆盖: ${targetName}`);
      }
      plan.push({ from: account.path, to: target });
    }
    return plan;
  }
}

/**
 * 解析命令行中的账号选择：auto、从 1 开始的序号，或唯一 uid 前缀。
 */
export function parseAccountSelector(input, accounts) {
  if (!Array.isArray(accounts)) {
    throw new TypeError('accounts 必须是账号数组');
  }
  const text = String(input ?? '').trim();

  if (text.toLowerCase() === 'auto') {
    return {
      kind: 'auto',
      uids: [...new Set(accounts.map((account) => account.uid))],
    };
  }

  if (/^\d+$/.test(text)) {
    const index = Number(text);
    if (!Number.isSafeInteger(index) || index < 1 || index > accounts.length) {
      throw new Error(`账号序号超出范围: ${text}\n候选:\n${candidateLines(accounts)}`);
    }
    return { kind: 'index', uids: [accounts[index - 1].uid] };
  }

  const matches = accounts.filter((account) => account.uid.startsWith(text));
  if (matches.length !== 1) {
    const reason = matches.length === 0 ? '没有匹配的 uid' : 'uid 前缀命中多个账号';
    const candidates = matches.length === 0 ? accounts : matches;
    throw new Error(`${reason}: ${text || '（空）'}\n候选:\n${candidateLines(candidates)}`);
  }

  return { kind: 'uid', uids: [matches[0].uid] };
}
