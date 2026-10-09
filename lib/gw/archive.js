/**
 * 极简 ZIP 读取：只负责一件事 —— 把网关二进制从 release 的 zip 里完整取出来。
 *
 * 为什么自带而不用依赖：插件要求纯标准库（node:zlib 的 inflateRawSync 就够），
 * 装一个 unzip 库会为「一年跑一两次的安装流程」引入几百个文件。
 *
 * 为什么只读中央目录（central directory）而不按 file header 顺序往下扫：
 * 文件头（local header）里的 compressedSize / crc32 允许是 0（流式打包时长度未知，
 * 数据描述符 data descriptor 在后面补），只有文件末尾的中央目录才记录权威值；
 * 另外 zip 允许前面塞任意前缀（自解压包就是这么干的），顺序扫会把前缀当成条目。
 * 所以入口必须是尾部 EOCD → 中央目录 → 用目录里的 localHeaderOffset 回跳。
 */

import { inflateRawSync } from 'node:zlib'

/** ZIP 相关错误。带 code，便于调用方分类处理（比如「不支持 ZIP64」值得单独提示）。 */
export class ZipError extends Error {
  constructor(message, code = 'ZIP_ERROR') {
    super(message)
    this.name = 'ZipError'
    this.code = code
  }
}

const SIG_LOCAL = 0x04034b50 // 文件头
const SIG_CENTRAL = 0x02014b50 // 中央目录条目
const SIG_EOCD = 0x06054b50 // 目录结束记录
const SIG_EOCD64 = 0x06064b50 // ZIP64 版目录结束记录
const SIG_LOC64 = 0x07064b50 // 指向 EOCD64 的定位器

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const FLAG_UTF8 = 0x0800 // bit 11：文件名/注释是 UTF-8，否则按 CP437/latin1 解
const MAX_COMMENT = 0xffff // EOCD 后面最多 64KB 注释，搜索范围由此确定
const U32_MAX = 0xffffffff // 该字段溢出到 ZIP64 的哨兵值

/** 解析中央目录，返回全部条目。 */
export function listEntries(buf) {
  if (!Buffer.isBuffer(buf)) throw new ZipError('输入必须是 Buffer', 'BAD_INPUT')
  const dir = locateDirectory(buf)
  const out = []
  let p = dir.offset
  const end = Math.min(buf.length, dir.offset + dir.size)
  for (let i = 0; i < dir.count; i++) {
    // 条目定长部分 46 字节；少一个字节都说明目录被截断，不能靠「读到哪算哪」糊过去
    if (p + 46 > buf.length) throw new ZipError('中央目录被截断', 'TRUNCATED')
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError(`中央目录第 ${i} 条签名错误（文件已损坏或不是 zip）`, 'BAD_CENTRAL')
    }
    const flags = buf.readUInt16LE(p + 8)
    const compressionMethod = buf.readUInt16LE(p + 10)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const nameAt = p + 46
    const rawName = buf.subarray(nameAt, nameAt + nameLen)
    const extra = buf.subarray(nameAt + nameLen, nameAt + nameLen + extraLen)
    const name = decodeName(rawName, flags)
    const z64 = zip64Fields(extra)
    out.push({
      name,
      compressionMethod,
      compressedSize: pickSize(buf.readUInt32LE(p + 20), z64.compressedSize, name, '压缩后大小'),
      uncompressedSize: pickSize(buf.readUInt32LE(p + 24), z64.uncompressedSize, name, '原始大小'),
      localHeaderOffset: pickSize(buf.readUInt32LE(p + 42), z64.localHeaderOffset, name, '文件头偏移'),
    })
    p = nameAt + nameLen + extraLen + commentLen
    if (p > end + 1) break // 目录长度与实际条目不一致时以长度为准，避免越界
  }
  return out
}

/** 取出单个文件。精确匹配优先；再退回按文件名匹配（release 包里二进制常带平台前缀目录）。 */
export function extractFile(buf, entryName) {
  const entries = listEntries(buf)
  const exact = entries.find((e) => e.name === entryName)
  if (exact) return readEntryData(buf, exact)
  const tail = (n) => n.split(/[\\/]/).pop()
  const loose = entries.filter((e) => tail(e.name) === tail(entryName))
  if (loose.length === 1) return readEntryData(buf, loose[0])
  if (loose.length > 1) {
    throw new ZipError(`zip 内有多个同名文件 ${entryName}，请传入完整路径`, 'AMBIGUOUS')
  }
  throw new ZipError(`zip 内找不到文件 ${entryName}`, 'NOT_FOUND')
}

/**
 * 定位中央目录。
 *
 * EOCD 在文件末尾，但后面可跟最多 64KB 注释，所以只能从尾部倒着扫。
 * 倒着扫还会撞上「注释里恰好有 0x06054b50」的假签名，因此额外校验
 * 「EOCD 起始 + 22 + 注释长度 === 文件长度」，吻合才认。
 */
function locateDirectory(buf) {
  const min = Math.max(0, buf.length - 22 - MAX_COMMENT)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue
    if (i + 22 + buf.readUInt16LE(i + 20) !== buf.length) continue
    return readDirectoryPointer(buf, i)
  }
  throw new ZipError('找不到目录结束记录：不是 zip 文件，或下载被截断', 'NO_EOCD')
}

/** 读 EOCD 的三件套：条目数、目录大小、目录偏移。溢出哨兵值走 ZIP64 路径。 */
function readDirectoryPointer(buf, eocdAt) {
  let count = buf.readUInt16LE(eocdAt + 10)
  let size = buf.readUInt32LE(eocdAt + 12)
  let offset = buf.readUInt32LE(eocdAt + 16)
  if (offset !== U32_MAX && count !== 0xffff) return { count, size, offset }
  // ZIP64：真值在 EOCD64 里，EOCD 前 20 字节是定位器
  const loc = eocdAt - 20
  if (loc < 0 || buf.readUInt32LE(loc) !== SIG_LOC64) {
    throw new ZipError('ZIP64 压缩包缺少定位记录，无法定位中央目录', 'ZIP64_UNSUPPORTED')
  }
  const at = Number(buf.readBigUInt64LE(loc + 8))
  if (at + 56 > buf.length || buf.readUInt32LE(at) !== SIG_EOCD64) {
    throw new ZipError('ZIP64 目录结束记录损坏', 'ZIP64_UNSUPPORTED')
  }
  count = Number(buf.readBigUInt64LE(at + 32))
  size = Number(buf.readBigUInt64LE(at + 40))
  offset = Number(buf.readBigUInt64LE(at + 48))
  return { count, size, offset }
}

/**
 * ZIP64 扩展字段（id 0x0001）。
 *
 * 字段按顺序出现，且**只有**对应 32 位字段溢出为 0xFFFFFFFF 时才存在，
 * 所以不能按固定偏移读，得按「缺谁补谁」的顺序往下取。
 */
function zip64Fields(extra) {
  const out = { uncompressedSize: null, compressedSize: null, localHeaderOffset: null }
  let p = 0
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p)
    const len = extra.readUInt16LE(p + 2)
    const body = extra.subarray(p + 4, p + 4 + len)
    p += 4 + len
    if (id !== 0x0001) continue
    // 顺序固定：原始大小 → 压缩后大小 → 文件头偏移（→ 起始磁盘号，用不到）
    let q = 0
    if (q + 8 <= body.length) { out.uncompressedSize = Number(body.readBigUInt64LE(q)); q += 8 }
    if (q + 8 <= body.length) { out.compressedSize = Number(body.readBigUInt64LE(q)); q += 8 }
    if (q + 8 <= body.length) { out.localHeaderOffset = Number(body.readBigUInt64LE(q)); q += 8 }
    break
  }
  return out
}

/** 32 位字段溢出时换 ZIP64 值；连 ZIP64 值都没有就只能报错，不能猜一个长度去切数据。 */
function pickSize(raw, fromZip64, name, label) {
  if (raw !== U32_MAX) return raw
  if (fromZip64 == null) {
    throw new ZipError(`条目 ${name} 的${label}需要 ZIP64 扩展字段，但该 zip 未提供，无法安全解压`, 'ZIP64_UNSUPPORTED')
  }
  return fromZip64
}

/** 文件名编码：bit 11 置位才是 UTF-8，否则按 latin1（CP437 的 ASCII 区间完全重合）。 */
function decodeName(raw, flags) {
  return raw.toString((flags & FLAG_UTF8) !== 0 ? 'utf8' : 'latin1')
}

/** 按中央目录给的偏移回到文件头，跳过文件名与额外字段后取数据。 */
function readEntryData(buf, entry) {
  const p = entry.localHeaderOffset
  if (p + 30 > buf.length) throw new ZipError(`条目 ${entry.name} 的文件头越界`, 'TRUNCATED')
  if (buf.readUInt32LE(p) !== SIG_LOCAL) {
    throw new ZipError(`条目 ${entry.name} 的文件头签名错误`, 'BAD_LOCAL')
  }
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const end = start + entry.compressedSize
  if (end > buf.length) throw new ZipError(`条目 ${entry.name} 的数据越界：zip 不完整`, 'TRUNCATED')
  const raw = buf.subarray(start, end)
  if (entry.compressionMethod === METHOD_STORE) return Buffer.from(raw)
  if (entry.compressionMethod === METHOD_DEFLATE) return inflateRawSync(raw)
  throw new ZipError(`条目 ${entry.name} 使用了不支持的压缩方式 ${entry.compressionMethod}（仅支持 store/deflate）`, 'BAD_METHOD')
}
