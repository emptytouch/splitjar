/**
 * `GET /api/previews` 的响应形状 —— **服务端写、看板读,所以住在 `shared/`**。
 *
 * 理由与 `shared/agentPay.ts` 里那批传输类型完全相同:两端必须一致的形状
 * 放 `shared/`,让它成为**结构上的事实**,而不是靠两边各写一份、靠人记得同步
 * (见 `shared/api.ts` 文件头那段)。
 *
 * ⚠️ 本文件两端共用,所以不许出现 `process.env`(浏览器里没有)
 * 也不许出现 `import.meta`(Node 里没有)。
 */

/**
 * 全部预览图的公开地址,键是**小写**的 `contentId`。
 *
 * ⚠️ 键必须小写,理由与 `shared/storage.ts` 的 `CONTENT_ID_RE` 只收小写
 * 是同一件事:同一个 contentId 不该有多个写法,否则查表会出现
 * "明明有、却查不到"。写入侧由 `loadPreviewUrls` 统一 `toLowerCase()`,
 * 读取侧(看板)那一行也必须小写 —— 两端各把一次关。
 */
export type PreviewsResponse = {
  previews: Record<string, string>
}
