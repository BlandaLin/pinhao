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
          throw new Error(tr("工作台服务返回的数据格式异常。请刷新页面后重试；再次出现时，请重新启动工作台。"));
        })) as {
          ok?: boolean;
          result?: unknown;
          error?: unknown;
          message?: string;
        };
        if (!response.ok || result.ok === false) {
          throw restoreCommandError(result.error ?? {
            message: result.message || tr`工作台服务处理请求失败（HTTP ${response.status}）。请稍后重试。`,
            statusCode: response.status,
          });
        }
        return result.result;
      };
    },
  });
}

export const api: DesktopApi = window.pinhao ?? browserApi();
const nativeTextRejectionMessage = tr("部分译文未通过游戏文字规则检查，尚未写入游戏。原回包和其他有效成果已保留；继续制作时会重新修正被拒绝的文字。");
export function errorMessage(error: unknown): string {
  const detail = error && typeof error === "object" ? error as {
    statusCode?: number; category?: string; retryAfterMs?: number; code?: string; name?: string;
  } : undefined;
  const status = detail?.statusCode, category = detail?.category;
  if (detail?.code === "NATIVE_TEXT_REJECTED") return nativeTextRejectionMessage;
  if (detail?.code === "NATIVE_DEPENDENCY_MISSING" || detail?.code === "NATIVE_DEPENDENCY_INVALID")
    return tr("程序所需的原生工具缺失或不完整，暂时无法自动提取。请修复工具文件或重新完整解压程序，再继续制作；已有成果会保留，不需要更换模型。");
  if (detail?.code === "FORMAT_SOURCE_STALE")
    return tr("游戏资源或验证条件已经变化。已有候选和成果会保留，请按当前资源重新验证。");
  if (detail?.code === "HOST_VERIFICATION_BLOCKED" || /FORMAT_.*(?:UNSUPPORTED|MISSING|REQUIRED|REVOKED)$/.test(detail?.code ?? ""))
    return tr("当前程序尚不能完成这类资源的定位或回写验证。候选与证据已保存，需补齐对应验证能力；更换模型不能替代此检查。");
  if (detail?.code === "MODEL_CAPACITY_REQUIRED")
    return tr("尚未确定这个模型的上下文和输出容量。请在“设置”的“模型容量”中按服务商规格填写，保存后继续。");
  if (detail?.code === "DSH_SESSION_SOURCE_CHANGED")
    return tr("游戏来源或技术任务身份已变化，不能接续这份旧执行记录。请核对游戏与工程位置；已有候选和成果会保留。");
  if (detail?.code === "DISPLAY_REVIEW_UNAVAILABLE" || category === "reviewer_unavailable")
    return tr("显示用途复核服务暂时不可用，候选没有因此被判定为错误。请检查接口后继续复核已保存的候选。");
  if (status === 403)
    return tr("模型服务拒绝了访问。请核对接口地址、密钥和模型访问权限，保存后重新测试连接。");
  if (status === 401 || category === "authentication")
    return tr("模型服务验证 API 密钥失败。请在“设置”中核对接口地址和密钥，保存后重新测试连接。");
  if (category === "provider_capacity")
    return tr("模型接口暂时达到在途请求预算。请等待现有请求完成后，再从已保存进度继续。");
  if (status === 402)
    return tr("模型服务的账户余额或可用额度不足。请到服务商页面查看账户状态，处理后继续任务。");
  if (status === 429 || category === "rate_limit") {
    const delay = typeof detail?.retryAfterMs === "number" && Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs > 0
      ? tr`服务商建议等待约 ${Math.ceil(detail.retryAfterMs / 1000)} 秒后重试。` : tr("请稍后重试。");
    return tr`模型服务收到的请求过多。${delay}也可以在“设置”中降低同时处理任务数。`;
  }
  if (status === 408 || status === 504 || category === "timeout" || detail?.code === "ETIMEDOUT" || detail?.name === "TimeoutError")
    return tr("模型服务响应超时。请检查网络或服务商状态，稍后重试。");
  const message = error instanceof Error ? error.message
    : error && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : String(error);
  if (/^(?:Submitted translations failed native text validation|New engine syntax is not permitted|New RenPy tag\/interpolation delimiter|New KAG\/Tyrano tag delimiter|New Twine macro\/link delimiter)$/.test(message))
    return nativeTextRejectionMessage;
  if (/safeStorage\.decryptString|ciphertext.*safeStorage|OSCrypt/i.test(message))
    return tr("读取已保存的 API 密钥失败。请在“设置”中重新填写并保存密钥，再继续任务。");
  if (/self[ -]signed certificate|unable to verify.*certificate|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID/i.test(message))
    return tr("模型服务的安全证书验证失败。请检查系统时间、代理和网络的证书设置，修正后重新测试连接。");
  if (/invalid api key|incorrect api key|api key is missing|authentication failed|HTTP\s*401\b/i.test(message))
    return tr("模型服务验证 API 密钥失败。请在“设置”中核对接口地址和密钥，保存后重新测试连接。");
  if (/insufficient[_ ](?:quota|balance)|HTTP\s*402\b/i.test(message))
    return tr("模型服务的账户余额或可用额度不足。请到服务商页面查看账户状态，处理后继续任务。");
  if (/rate[_ ]limit|too many requests|HTTP\s*429\b/i.test(message))
    return tr("模型服务收到的请求过多。请稍后重试，也可以在“设置”中降低同时处理任务数。");
  if (/maximum context length|context_length_exceeded|context window.*exceed|input token.*exceed/i.test(message))
    return tr("本次内容超出了模型可处理的长度。请在“设置”中选择能处理更长文本的模型，再继续任务。");
  if (/fetch failed|failed to fetch|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|network error/i.test(message))
    return tr("连接服务失败。请检查网络和 API 接口地址后重试；再次出现时，请重新启动工作台。");
  return uiMessage(message);
}
