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
    description: tr("分析游戏文件，处理文字提取与构建问题。"),
  },
  {
    id: "translation",
    name: tr("文字模型（翻译与校对）"),
    description: tr("按场景翻译文字，校对译文、人物称呼和用词。"),
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
        description={tr("配置模型连接、制作选项和游戏字体。")}
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
              <p>{tr("支持 OpenAI 兼容接口，包括提供该接口的本地模型。")}</p>
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
                <small>{tr("所有项目共用此上限，包括技术处理、翻译、校对和图片文字识别。")}</small>
              </label>
              <label className="field">
                <span>{tr("目标语言")}</span>
                <input
                  value={draft.targetLanguage}
                  onChange={(event) =>
                    update({ ...draft, targetLanguage: event.target.value })
                  }
                />
                <small>{tr("例如：zh-Hans（简体中文）、en（英语）。")}</small>
              </label>
            </div>
          </details>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>{tr("任务模型")}</h2>
              <p>{tr("默认共用上方连接，也可分别设置。翻译与校对共用文字模型。")}</p>
            </div>
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
            </div>
          </div>
          <div className="preferences">
            <label className="toggle-line">
              <div>
                <strong>{tr("翻译后进行校对")}</strong>
                <small>{tr("初翻完成后，使用文字模型校对译文、人物称呼和译名。")}</small>
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
                <strong>{tr("个别任务失败时暂停")}</strong>
                <small>{tr("个别任务重试后仍失败时暂停；关闭后保留当前文字或原图，继续其他任务。")}</small>
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
                <small>{tr("支持平整背景 PNG 的局部文字翻译和回写；其他图片保持原样。")}</small>
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
              <p>{tr("成品将使用所选字体，也可选择自己的 TTF/OTF 文件。")}</p>
            </div>
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
          <p className="font-license-note">{tr("内置字体采用 SIL Open Font License，许可证随成品提供。")}</p>
        </section>
        <div className="settings-bottom">
          <span>{dirty ? tr("设置修改尚未保存") : tr("当前设置已保存")}</span>
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
        <small>{tr("使用服务商提供的 API 基础地址。")}</small>
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
        <p className="muted">{tr("留空默认：上下文 32,768 tokens，单次回复 4,096 tokens。修改时填写服务商给出的容量。")}</p>
        <div className="settings-grid">
          <label className="field">
            <span>{tr("上下文容量（tokens）")}</span>
            <input type="number" min="1" step="1" max={Number.MAX_SAFE_INTEGER}
              aria-label={tr`${label}上下文容量`} placeholder={tr("程序默认")}
              value={value.contextWindow ?? ""}
              onChange={event => onChange({ ...value, contextWindow: event.target.value === "" ? undefined : Number(event.target.value) })} />
            <small>{tr("每次请求中，输入、历史和回复的合计上限。")}</small>
          </label>
          <label className="field">
            <span>{tr("最大回复长度（tokens）")}</span>
            <input type="number" min="1" step="1" max={Number.MAX_SAFE_INTEGER}
              aria-label={tr`${label}最大回复长度`} placeholder={tr("程序默认")}
              value={value.maxOutputTokens ?? ""}
              onChange={event => onChange({ ...value, maxOutputTokens: event.target.value === "" ? undefined : Number(event.target.value) })} />
            <small>{tr("单次回复的上限，按模型支持的输出容量填写。")}</small>
          </label>
        </div>
      </details>
    </div>
  );
}
