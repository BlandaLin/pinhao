import { tr, uiMessage } from "../shared/ui-language.js";
import type { DesktopApi } from "../../../packages/contracts/index";
import { restoreCommandError } from "../../../packages/contracts/command-errors.js";

declare global {
  interface Window {
    pinhao?: DesktopApi;
  }
}

export const nativeDesktop = Boolean(window.pinhao);

function browserApi(): DesktopApi {
  return new Proxy({} as DesktopApi, {
    get(_target, method: string) {
      if (method === "onChanged") return undefined;
      return async (input: unknown = {}) => {
        const response = await fetch(`/api/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const result = (await response.json().catch(() => {
          throw new Error(tr("工作台返回的数据格式错误。请刷新页面或重启程序后重试。"));
        })) as {
          ok?: boolean;
          result?: unknown;
          error?: unknown;
          message?: string;
        };
        if (!response.ok || result.ok === false) {
          throw restoreCommandError(result.error ?? {
            message: result.message || tr`工作台请求失败（HTTP ${response.status}）。请稍后重试。`,
            statusCode: response.status,
          });
        }
        return result.result;
      };
    },
  });
}

export const api: DesktopApi = window.pinhao ?? browserApi();
const nativeTextRejectionMessage = tr("部分译文未通过游戏文字规则检查，尚未写入游戏。原回包和其他有效成果已保留。继续制作时修正被拒绝的文字及必要关联项。");
export function errorMessage(error: unknown): string {
  const detail = error && typeof error === "object" ? error as {
    statusCode?: number; category?: string; retryAfterMs?: number; code?: string; name?: string;
  } : undefined;
  const status = detail?.statusCode, category = detail?.category;
  if (detail?.code === "NATIVE_TEXT_REJECTED") return nativeTextRejectionMessage;
  if (detail?.code === "NATIVE_DEPENDENCY_MISSING" || detail?.code === "NATIVE_DEPENDENCY_INVALID")
    return tr("原生工具缺失或不完整。请修复工具文件或重新完整解压程序。已有成果会保留，不需要更换模型。");
  if (detail?.code === "FORMAT_SOURCE_STALE")
    return tr("游戏资源或验证条件已变化。候选与成果已保留，请按当前资源重新验证。");
  if (detail?.code === "HOST_VERIFICATION_BLOCKED" || /FORMAT_.*(?:UNSUPPORTED|MISSING|REQUIRED|REVOKED)$/.test(detail?.code ?? ""))
    return tr("这类资源的文字位置或写回结果还无法验证。调查结果已保存，请保留工程并反馈此问题。");
  if (detail?.code === "MODEL_CAPACITY_REQUIRED")
    return tr("模型容量未设置。请在“设置”的“模型容量”填写服务商公布的上下文和最大回复长度。");
  if (detail?.code === "DSH_SESSION_SOURCE_CHANGED")
    return tr("游戏来源或技术任务已变化，无法接续原记录。请核对游戏与工程位置；已有成果保留。");
  if (detail?.code === "DISPLAY_REVIEW_UNAVAILABLE" || category === "reviewer_unavailable")
    return tr("文字用途复核暂时不可用。候选已保留，请检查接口后继续。");
  if (status === 403)
    return tr("模型服务拒绝访问。请核对接口地址、密钥和模型权限，再测试连接。");
  if (status === 401 || category === "authentication")
    return tr("API 密钥验证失败。请在“设置”核对接口地址和密钥，保存后重新测试连接。");
  if (category === "provider_capacity")
    return tr("当前连接的在途请求额度已用满。请等待正在处理的请求结束后继续。");
  if (status === 402)
    return tr("模型账户余额或额度不足。请到服务商页面查看账户状态，处理后继续。");
  if (status === 429 || category === "rate_limit") {
    const delay = typeof detail?.retryAfterMs === "number" && Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs > 0
      ? tr`服务商建议等待约 ${Math.ceil(detail.retryAfterMs / 1000)} 秒后重试。` : tr("请稍后重试。");
    return tr`请求过于频繁。${delay}也可在“设置”中降低同时处理任务数。`;
  }
  if (status === 408 || status === 504 || category === "timeout" || detail?.code === "ETIMEDOUT" || detail?.name === "TimeoutError")
    return tr("模型响应超时。请检查网络或服务商状态后重试。");
  const message = error instanceof Error ? error.message
    : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : String(error);
  if (/^(?:Submitted translations failed native text validation|New engine syntax is not permitted|New RenPy tag\/interpolation delimiter|New KAG\/Tyrano tag delimiter|New Twine macro\/link delimiter)$/.test(message))
    return nativeTextRejectionMessage;
  if (/safeStorage\.decryptString|ciphertext.*safeStorage|OSCrypt/i.test(message))
    return tr("无法读取已保存的 API 密钥。请在“设置”重新填写并保存密钥。");
  if (/self[ -]signed certificate|unable to verify.*certificate|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID/i.test(message))
    return tr("安全证书验证失败。请检查系统时间、代理和网络证书设置后重试。");
  if (/invalid api key|incorrect api key|api key is missing|authentication failed|HTTP\s*401\b/i.test(message))
    return tr("API 密钥验证失败。请在“设置”核对接口地址和密钥，保存后重新测试连接。");
  if (/insufficient[_ ](?:quota|balance)|HTTP\s*402\b/i.test(message))
    return tr("模型账户余额或额度不足。请到服务商页面查看账户状态，处理后继续。");
  if (/rate[_ ]limit|too many requests|HTTP\s*429\b/i.test(message))
    return tr("请求过于频繁。请稍后重试，或在“设置”中降低同时处理任务数。");
  if (/maximum context length|context_length_exceeded|context window.*exceed|input token.*exceed/i.test(message))
    return tr("请求内容超出模型容量。请在“设置”选择能处理更长文本的模型。");
  if (/fetch failed|failed to fetch|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|network error/i.test(message))
    return tr("连接模型服务失败。请检查网络和 API 接口地址后重试。");
  return uiMessage(message);
}
