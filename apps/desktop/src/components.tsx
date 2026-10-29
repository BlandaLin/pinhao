import { tr } from "../shared/ui-language.js";
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { FolderOpen, LoaderCircle, X } from "lucide-react";
import type { ProjectStatus } from "../../../packages/contracts/index";
import { api, nativeDesktop } from "./api";

export function Button({
  children,
  variant = "secondary",
  busy,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={`button ${variant} ${className}`}
    >
      {busy && <LoaderCircle size={15} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Heading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <header className="heading">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {children && <div className="heading-actions">{children}</div>}
    </header>
  );
}

export const statuses: Record<ProjectStatus, string> = {
  preparing: tr("整理游戏"),
  ready: tr("准备就绪"),
  running: tr("正在制作"),
  paused: tr("已暂停"),
  completed: tr("本轮已完成"),
  failed: tr("制作失败"),
};
export function Status({ value }: { value: ProjectStatus }) {
  const active = value === "running" || value === "preparing";
  return (
    <span className={`status ${value}`}>
      {active ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <i />}
      {statuses[value]}
    </span>
  );
}

export function LoadingState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle size={27} className="spin" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{detail}</p>
    </div>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-emblem">{tr("文")}</div>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function PathField({
  label,
  value,
  onChange,
  kind = "directory",
  placeholder,
  onError,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  kind?: "directory" | "font" | "package" | "save";
  placeholder?: string;
  onError: (error: unknown) => void;
}) {
  async function browse() {
    try {
      const result =
        kind === "directory"
          ? await api.chooseDirectory({ title: label })
          : kind === "save"
            ? await api.chooseSaveFile({ title: label, defaultPath: value })
            : await api.chooseFile({ title: label, kind });
      if (result) onChange(result);
    } catch (error) {
      onError(error);
    }
  }
  return (
    <label className="field">
      <span>{label}</span>
      <div className="path-input">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
        {nativeDesktop && (
          <button
            type="button"
            className="icon-button"
            aria-label={tr`选择${label}`}
            onClick={() => void browse()}
          >
            <FolderOpen size={18} />
          </button>
        )}
      </div>
    </label>
  );
}

export function Modal({
  title,
  children,
  onClose,
  busy = false,
  error,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  error?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="dialog-content">
        <header>
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label={tr("关闭对话框")}
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </header>
        {error && (
          <div role="alert" className="banner error">
            {error}
          </div>
        )}
        {children}
      </div>
    </dialog>
  );
}

export function Progress({
  total,
  done,
  skipped,
}: {
  total: number;
  done: number;
  skipped: number;
}) {
  const progress =
    total > 0 ? Math.min(100, ((done + skipped) / total) * 100) : 0;
  return (
    <div className="progress-wrap">
      <div
        className="progress"
        role="progressbar"
        aria-valuenow={done + skipped}
        aria-valuemin={0}
        aria-valuemax={total || 1}
        aria-label={tr("文字处理进度")}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="progress-caption">
        <span>
          {done.toLocaleString()} / {total.toLocaleString()}{tr(" 条")}</span>
        <span>
          {skipped > 0 ? tr`${skipped} 条保留原文` : `${Math.round(progress)}%`}
        </span>
      </div>
    </div>
  );
}
