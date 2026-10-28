import { useState } from 'react';
import type { AssistSaveBackups } from '../../../packages/contracts/index';
import { Button, Modal } from './components';

export default function AssistSaveBackupDialog({ data, busy, onClose, onRestore }: {
  data: AssistSaveBackups;
  busy: boolean;
  onClose: () => void;
  onRestore: (backupId: string) => void;
}) {
  const [selected, setSelected] = useState(data.backups.find(item => item.status === 'available')?.id || '');
  const backup = data.backups.find(item => item.id === selected);
  return <Modal title="恢复存档备份" busy={busy} onClose={onClose}>
    <p className="dialog-intro">恢复目标：{backup?.filePath || '先选择一份可用备份'}</p>
    <p className="dialog-intro">恢复到这份备份原来绑定的存档位置。目标存在时先保留原始文件，目标不存在时重新创建；请先关闭游戏，恢复后在游戏中读档。</p>
    {data.backups.length ? <label className="field">
      <span>选择备份时间</span>
      <select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
        {data.backups.map(backup => <option key={backup.id} value={backup.id} disabled={backup.status !== 'available'}>
          {backup.createdAt ? new Date(backup.createdAt).toLocaleString() : '时间未知'} · {backup.bytes?.toLocaleString() ?? '?'} 字节 · {backup.id.slice(0, 8)}{backup.status !== 'available' ? ' · 不可用' : ''}
        </option>)}
      </select>
    </label> : <p className="dialog-intro">当前项目与成品还没有可核对来源的备份。</p>}
    {data.backups.filter(item => item.status === 'unavailable').map(item => <p key={item.id} className="dialog-intro">不可用记录 {item.id.slice(0, 8)}：{item.error || '未通过备份核验'}</p>)}
    <div className="dialog-actions">
      <Button disabled={busy} onClick={onClose}>取消</Button>
      <Button variant="primary" disabled={backup?.status !== 'available' || busy} busy={busy} onClick={() => onRestore(selected)}>确认恢复</Button>
    </div>
  </Modal>;
}
