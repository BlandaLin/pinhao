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
    text: tr("在“设置”填写接口地址、模型名和 API 密钥，保存后点击“测试已保存连接”。"),
    icon: PlugZap,
  },
  {
    title: tr("拖入游戏"),
    text: tr("拖入游戏文件夹或启动程序。工程默认建在游戏旁边，保存译文与进度，原版保持不变。"),
    icon: Upload,
  },
  {
    title: tr("开始制作"),
    text: tr("在“制作总览”点击“开始翻译与校对”。进度自动保存，暂停后可继续。"),
    icon: BookOpenText,
  },
  {
    title: tr("试玩与分享"),
    text: tr("在“成品与导出”查看生成结果。试玩并检查对白、选项、字体和存读档后，再导出分享 ZIP。"),
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
          <p>{tr("按下面四步，制作独立汉化版。")}</p>
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
        {tr("外部翻译可使用“文字工作台”的导出、导入文字工作包功能。")}
        {" "}{tr("从侧栏“使用教程”重新打开本指南。")}
      </p>
      <div className="dialog-actions">
        <Button onClick={onClose}>{tr("先看看界面")}</Button>
        <Button variant="primary" onClick={onConfigure}>{tr("配置模型")}</Button>
      </div>
    </Modal>
  );
}
