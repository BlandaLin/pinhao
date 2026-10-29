import { useRef, useState, type FormEvent } from "react";
import { Check, KeyRound, PlugZap, Save, Settings2 } from "lucide-react";
import type {
  ModelConnection,
  DesktopApi,
  FontPreset,
  Role,
  Settings,
} from "../../../packages/contracts/index";
import { Button, Heading, PathField } from "./components";
import { api, errorMessage } from "./api";
import { tr, trc, uiMessage } from "../shared/ui-language.js";

type ConnectionTestResult = Awaited<ReturnType<DesktopApi["testConnection"]>>;

const roles: { id: Role; name: string; description: string }[] = [
  {
    id: "technical",
    name: tr("技术模型"),
    description: tr("分析游戏文件，提取文字并处理制作中的技术问题。"),
  },
  {
    id: "translation",
    name: tr("文字模型（翻译与校对）"),
    description: tr("按完整场景翻译文字，再用同一模型检查准确性、人物称呼和表达。"),
  },
];

function clearKeys(settings: Settings): Settings {
  return {
    ...settings,
    connection: { ...settings.connection, apiKey: "" },
    roles: Object.fromEntries(
      Object.entries(settings.roles).map(([id, role]) => [
        id,
        {
          ...role,
          connection: { ...role.connection, apiKey: "" },
        },
      ]),
    ) as Settings["roles"],
  };
}

export default function SettingsPage({
  settings,
  fonts,
  busy,
  onSave,
  onTest,
  onError,
}: {
  settings: Settings;
  fonts: FontPreset[];
  busy: string;
  onSave: (settings: Settings) => Promise<Settings | undefined>;
  onTest: (
    role?: Role,
  ) => Promise<ConnectionTestResult | undefined>;
  onError: (error: unknown) => void;
}) {
  const [draft, setDraft] = useState<Settings>(() => clearKeys(settings));
  const [dirty, setDirty] = useState(false);
  const editRevision = useRef(0);
  const [customFont, setCustomFont] = useState(() => Boolean(settings.fontPath) && !fonts.some(font => font.path === settings.fontPath));
  const [test, setTest] = useState<(ConnectionTestResult & { role: string }) | null>(null);
  function update(next: Settings) {
    editRevision.current++;
    setDraft(next);
    setDirty(true);
  }
  function updateConnection(connection: ModelConnection) {
    update({ ...draft, connection });
  }
  function updateRole(id: Role, connection: ModelConnection) {
    update({
      ...draft,
      roles: { ...draft.roles, [id]: { ...draft.roles[id], connection } },
    });
  }
  async function chooseCustomFont() {
    try {
      const fontPath = await api.chooseFile({ kind: 'font', title: tr('选择游戏字体') });
      if (fontPath) { setCustomFont(true); update({ ...draft, fontPath }); }
    } catch (error) { onError(error); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const submittedRevision = editRevision.current;
    const saved = await onSave(draft);
    if (saved && editRevision.current === submittedRevision) {
      setDraft(clearKeys(saved));
      setDirty(false);
    }
  }
  async function testRole(role?: Role) {
    const result = await onTest(role);
    if (result) setTest({ role: role || "shared", ...result });
  }

  return (
    <>
      <Heading
        title={tr("设置")}
        description={tr("填写模型服务的连接信息，设置翻译、校对和成品字体。")}
      >
        <Button
          type="submit"
          form="settings-form"
          variant="primary"
          busy={busy === "settings"}
          disabled={!dirty || Boolean(busy)}
        >
          <Save size={16} />
          {tr("保存设置")}
        </Button>
      </Heading>
      <form id="settings-form" onSubmit={(event) => void submit(event)}>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{tr("API 连接")}</h2>
              <p>{tr("API 用于连接模型服务。填写服务商提供的接口地址、模型名称和密钥，使用 OpenAI 兼容格式的接口。本地模型也可按此方式连接。")}</p>
            </div>
            <PlugZap size={21} />
          </div>
          <ConnectionFields
            value={draft.connection}
            onChange={updateConnection}
            label={tr("共享连接")}
          />
          <div className="settings-test">
            <Button
              busy={busy === "test-shared"}
              disabled={Boolean(busy) || dirty}
              onClick={() => void testRole()}
            >
              <PlugZap size={16} />
              {tr("测试已保存连接")}
            </Button>
            {dirty && <small>{tr("先点击“保存设置”，再测试连接。")}</small>}
            <small>{tr("连接测试会发送一条简短的模型请求，费用按服务商规则计算。")}</small>
            {test?.role === "shared" && (
              <span className={test.ok ? "test-success" : "test-error"}>
                  {test.ok ? uiMessage(test.message) : errorMessage(test)}
              </span>
            )}
          </div>
          <details className="advanced">
            <summary>
              <Settings2 size={16} />
              {tr("高级设置")}
            </summary>
            <div className="settings-grid">
              <label className="field">
                <span>{tr("同时处理任务数")}</span>
                <select
                  value={draft.concurrency}
                  onChange={(event) =>
                    update({
                      ...draft,
                      concurrency: Number(event.target.value),
                    })
                  }
                >
                  {Array.from({ length: 32 }, (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      {index + 1}
                      {index === 2 ? tr("（默认）") : ""}
                    </option>
                  ))}
                </select>
                <small>{tr("这是所有项目合计的上限，包含游戏文件处理、翻译、校对和图片文字识别（OCR）。")}</small>
              </label>
              <label className="field">
                <span>{tr("目标语言")}</span>
                <input
                  value={draft.targetLanguage}
                  onChange={(event) =>
                    update({ ...draft, targetLanguage: event.target.value })
                  }
                />
                <small>{tr("填写希望译成的语言，例如 zh-Hans（简体中文）或 en（英语）。")}</small>
              </label>
            </div>
          </details>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{tr("任务模型")}</h2>
              <p>{tr("技术模型与文字模型默认使用上方的 API 连接。关闭“使用共享连接”可单独设置；翻译与校对共用文字模型。")}</p>
            </div>
            <span className="tag gold">{tr("任务说明已内置")}</span>
          </div>
          <div className="role-grid">
            {roles.map((role) => (
              <section className="role-card" key={role.id}>
                <h3>{role.name}</h3>
                <p>{role.description}</p>
                <label className="toggle-line">
                  <span>{tr("使用共享连接")}</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.roles[role.id].useShared}
                    onChange={(event) =>
                      update({
                        ...draft,
                        roles: {
                          ...draft.roles,
                          [role.id]: {
                            ...draft.roles[role.id],
                            useShared: event.target.checked,
                          },
                        },
                      })
                    }
                  />
                </label>
                {draft.roles[role.id].useShared ? (
                  <div className="shared-model">
                    <Check size={16} />
                    <span>{draft.connection.model || tr("使用上方填写的模型")}</span>
                  </div>
                ) : (
                  <>
                    <ConnectionFields
                      compact
                      value={draft.roles[role.id].connection}
                      onChange={(connection) => updateRole(role.id, connection)}
                      label={role.name}
                    />
                    <Button
                      busy={busy === `test-${role.id}`}
                      disabled={Boolean(busy) || dirty}
                      onClick={() => void testRole(role.id)}
                    >
                      {tr("测试已保存连接")}
                    </Button>
                  </>
                )}
                {test?.role === role.id && (
                  <p className={test.ok ? "test-success" : "test-error"}>
                    {test.ok ? uiMessage(test.message) : errorMessage(test)}
                  </p>
                )}
              </section>
            ))}
          </div>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{tr("制作偏好")}</h2>
              <p>{tr("设置翻译后的校对、失败时的处理方式，以及是否翻译图片文字。")}</p>
            </div>
          </div>
          <div className="preferences">
            <label className="toggle-line">
              <div>
                <strong>{tr("翻译后进行校对")}</strong>
                <small>{tr("自动制作会先完成本轮初翻，汇总译名分歧，再由同一文字模型校对；不另设付费词表整理阶段。")}</small>
              </div>
              <input
                type="checkbox"
                role="switch"
                checked={draft.proofreading}
                onChange={(event) =>
                  update({ ...draft, proofreading: event.target.checked })
                }
              />
            </label>
            <label className="toggle-line">
              <div>
                <strong>{tr("遇到局部失败时暂停")}</strong>
                <small>{tr("开启后，个别任务重试失败会暂停制作；关闭时保留该条当前文字或原图，继续处理其余内容。")}</small>
              </div>
              <input
                type="checkbox"
                role="switch"
                checked={draft.pauseOnLocalFailure}
                onChange={(event) =>
                  update({
                    ...draft,
                    pauseOnLocalFailure: event.target.checked,
                  })
                }
              />
            </label>
            <label className="toggle-line">
              <div>
                <strong>{tr("处理图片文字")}</strong>
                <small>{tr("识别可处理图片中的文字，再翻译并尝试写回。当前支持平整背景 PNG 的局部文字修改，其余图片保持原样。")}</small>
              </div>
              <input
                type="checkbox"
                role="switch"
                checked={draft.processImages}
                onChange={(event) =>
                  update({ ...draft, processImages: event.target.checked })
                }
              />
            </label>
          </div>
        </section>
        <section className="panel font-panel">
          <div className="panel-heading">
            <div>
              <h2>{tr("游戏字体")}</h2>
              <p>{tr("所选字体用于生成汉化成品。选择下方字形预览，或使用自己的字体文件。")}</p>
            </div>
            <span className="tag gold">{tr("内置开源字体")}</span>
          </div>
          <style>{fonts.map(font => `@font-face {font-family: "PinhaoPreview-${font.id}"; src: url(${JSON.stringify(font.previewUrl)}); font-weight: 400; font-style: normal; font-display: swap;}`).join('\n')}</style>
          <fieldset className="font-choices">
            <legend className="sr-only">{tr("选择游戏字体")}</legend>
            {fonts.map(font => (
              <label className={`font-choice ${!customFont && draft.fontPath === font.path ? 'selected' : ''}`} key={font.id}>
                <div className="font-choice-title">
                  <span><strong>{uiMessage(font.name)}</strong><small>{uiMessage(font.style)}</small></span>
                  <input type="radio" name="game-font" checked={!customFont && draft.fontPath === font.path}
                    onChange={() => { setCustomFont(false); update({ ...draft, fontPath: font.path }); }} />
                </div>
                <div className="font-preview" aria-label={tr("中文字形预览")} style={{ fontFamily: `"PinhaoPreview-${font.id}"` }}>山河入梦<br />故事新生</div>
                <p>{uiMessage(font.description)}</p>
                {font.id === 'kai' && <span className="font-default">{tr("默认字体")}</span>}
              </label>
            ))}
          </fieldset>
          <div className="font-other-options">
            <label><input type="radio" name="game-font" checked={!customFont && !draft.fontPath}
              onChange={() => { setCustomFont(false); update({ ...draft, fontPath: '' }); }} />{tr("沿用游戏原字体")}</label>
            <label><input type="radio" name="game-font" checked={customFont}
              onChange={() => void chooseCustomFont()} />{tr("选择自己的字体")}</label>
          </div>
          {customFont && <PathField label={tr("自选字体文件")} kind="font" value={draft.fontPath}
            onChange={fontPath => update({ ...draft, fontPath })} placeholder={tr("选择 TTF 或 OTF 字体")} onError={onError} />}
          <p className="font-license-note">{tr("思源宋体、思源黑体与霞鹜文楷均采用 SIL Open Font License（开源字体许可）。制作时附带所选内置字体的许可证。")}</p>
        </section>
        <div className="settings-bottom">
          <span>{dirty ? tr("点击“保存设置”应用本次修改") : tr("当前设置已保存")}</span>
          <Button
            type="submit"
            variant="primary"
            busy={busy === "settings"}
            disabled={!dirty || Boolean(busy)}
          >
            <Save size={16} />
            {tr("保存设置")}
          </Button>
        </div>
      </form>
    </>
  );
}

function ConnectionFields({
  value,
  onChange,
  label,
  compact = false,
}: {
  value: ModelConnection;
  onChange: (connection: ModelConnection) => void;
  label: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "connection compact" : "connection"}>
      <label className="field">
        <span>{tr("接口地址")}</span>
        <input
          aria-label={tr`${label}接口地址`}
          autoComplete="off"
          value={value.baseUrl}
          onChange={(event) =>
            onChange({ ...value, baseUrl: event.target.value })
          }
          placeholder="https://api.example.com/v1"
        />
        <small>{tr("填写服务商提供的 API 基础地址，通常以 /v1 结尾。")}</small>
      </label>
      <label className="field">
        <span>{tr("模型名称")}</span>
        <input
          aria-label={tr`${label}模型名称`}
          autoComplete="off"
          value={value.model}
          onChange={(event) =>
            onChange({ ...value, model: event.target.value })
          }
          placeholder={tr("填写服务商列出的完整模型名称")}
        />
      </label>
      <label className="field key-field">
        <span>
          {tr("API 密钥")}{" "}
          <small>
            <KeyRound size={12} />
            {value.hasKey ? tr("已保存") : tr("待填写")}
          </small>
        </span>
        <input
          aria-label={tr`${label}API密钥`}
          type="password"
          autoComplete="new-password"
          value={value.apiKey || ""}
          onChange={(event) =>
            onChange({ ...value, apiKey: event.target.value })
          }
          placeholder={
            value.hasKey ? tr("留空保留已保存密钥，输入新密钥可替换") : tr("填写模型服务商提供的 API 密钥")
          }
        />
      </label>
      <label className="field" style={{ gridColumn: "1 / -1" }}>
        <span>{tr("模型推理")}</span>
        <select
          aria-label={tr`${label}模型推理`}
          value={value.reasoning ?? "auto"}
          onChange={(event) =>
            onChange({ ...value, reasoning: event.target.value as ModelConnection["reasoning"] })
          }
        >
          <option value="auto">{tr("跟随模型默认（推荐）")}</option>
          <option value="enabled">{trc("reasoning", "开启")}</option>
          <option value="disabled">{trc("reasoning", "关闭")}</option>
        </select>
      </label>
      <details className="advanced" style={{ gridColumn: "1 / -1" }}>
        <summary>{tr("模型容量")}</summary>
        <p className="muted">{tr("技术、翻译与校对请求使用此容量。留空时使用 32,768 上下文、单次回复至多 4,096 的程序默认值；这不是自动识别。按服务商规格填写，可使用模型实际支持的容量。")}</p>
        <div className="settings-grid">
          <label className="field">
            <span>{tr("上下文容量（tokens）")}</span>
            <input type="number" min="1" step="1" max={Number.MAX_SAFE_INTEGER}
              aria-label={tr`${label}上下文容量`} placeholder={tr("程序默认")}
              value={value.contextWindow ?? ""}
              onChange={event => onChange({ ...value, contextWindow: event.target.value === "" ? undefined : Number(event.target.value) })} />
            <small>{tr("模型单次能处理的原文、历史和回复总量。")}</small>
          </label>
          <label className="field">
            <span>{tr("最大回复长度（tokens）")}</span>
            <input type="number" min="1" step="1" max={Number.MAX_SAFE_INTEGER}
              aria-label={tr`${label}最大回复长度`} placeholder={tr("程序默认")}
              value={value.maxOutputTokens ?? ""}
              onChange={event => onChange({ ...value, maxOutputTokens: event.target.value === "" ? undefined : Number(event.target.value) })} />
            <small>{tr("按该模型支持的最大输出填写，不是累计使用额度。")}</small>
          </label>
        </div>
      </details>
    </div>
  );
}
