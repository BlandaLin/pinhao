import { BookOpenText, Package, PlugZap, Upload } from "lucide-react";
import { Button, Modal } from "./components";
import { tr } from "../shared/ui-language.js";

const welcomeKey = "pinhao.welcome.v1";

export function hasSeenWelcome() {
  try {
    return localStorage.getItem(welcomeKey) === "seen";
  } catch {
    return false;
  }
}

export function rememberWelcome() {
  try {
    localStorage.setItem(welcomeKey, "seen");
  } catch {
    // The guide remains available when local storage is unavailable.
  }
}

const steps = [
  {
    title: tr("连接模型"),
    text: tr("打开“设置”，填写模型服务商提供的接口地址、模型名称与 API 密钥。API 用于连接模型服务；保存后点击“测试已保存连接”。"),
    icon: PlugZap,
  },
  {
    title: tr("拖入游戏"),
    text: tr("把游戏文件夹或启动程序拖入窗口。软件在游戏旁建立“游戏名-拼好工程”，读取原资源、按需创建副本；译文与进度保存在工程里，原版游戏保持不变。"),
    icon: Upload,
  },
  {
    title: tr("开始制作"),
    text: tr("在“制作总览”点击“开始翻译与校对”：先初翻，再校对，最后生成成品。译名在翻译中积累，不必先整理整套词表；已完成进度持续保存，可以暂停后继续。"),
    icon: BookOpenText,
  },
  {
    title: tr("试玩与分享"),
    text: tr("生成后进入“成品与导出”，有启动入口时可直接试玩。检查对话、选项、字体和存档后，再决定是否导出分享 ZIP。文字覆盖百分比只统计已提取内容，不代表整款游戏已验证。"),
    icon: Package,
  },
];

export default function WelcomeGuide({
  onClose,
  onConfigure,
}: {
  onClose: () => void;
  onConfigure: () => void;
}) {
  return (
    <Modal title={tr("欢迎使用拼好汉化")} onClose={onClose}>
      <div className="welcome-intro">
        <img src="./pinhao-logo.png" alt="" width="60" height="60" />
        <div>
          <h3>{tr("从一个游戏开始")}</h3>
          <p>{tr("准备游戏和自己的模型服务，按下面四步制作汉化版。")}</p>
        </div>
      </div>
      <ol className="welcome-steps">
        {steps.map(({ title, text, icon: Icon }, index) => (
          <li key={title}>
            <span className="welcome-step-number" aria-hidden="true">{index + 1}</span>
            <div><h3>{title}</h3><p>{text}</p></div>
            <Icon size={20} aria-hidden="true" />
          </li>
        ))}
      </ol>
      <p className="welcome-note">
        {tr("如需交给外部 AI 或译者处理，在“文字工作台”导出文字工作包，处理后将工作包导回。")}
        {" "}{tr("随时点击侧栏“使用教程”重看这份指南。")}
      </p>
      <div className="dialog-actions">
        <Button onClick={onClose}>{tr("先看看界面")}</Button>
        <Button variant="primary" onClick={onConfigure}>{tr("配置模型")}</Button>
      </div>
    </Modal>
  );
}
