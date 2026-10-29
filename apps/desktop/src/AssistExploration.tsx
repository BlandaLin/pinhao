import { tr } from "../shared/ui-language.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Compass, MapPin, RotateCcw, Search } from "lucide-react";
import type {
  AssistMap,
  AssistState,
  DesktopApi,
} from "../../../packages/contracts/index";
import { api, errorMessage } from "./api";
import {
  assistDestination,
  assistMoveSpeeds,
  supportedAssistActions,
} from "./assist-view";
import { Button, Modal } from "./components";

type Command = Omit<Parameters<DesktopApi["assistCommand"]>[0], "projectId">;

export default function AssistExploration({
  projectId,
  state,
  busy,
  onCommand,
}: {
  projectId: string;
  state: AssistState;
  busy: boolean;
  onCommand: (command: Command) => Promise<boolean>;
}) {
  const [maps, setMaps] = useState<AssistMap[]>([]);
  const [loading, setLoading] = useState(true);
  const [mapReload, setMapReload] = useState(0);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [mapId, setMapId] = useState("");
  const [x, setX] = useState("");
  const [y, setY] = useState("");
  const [direction, setDirection] = useState("2");
  const [dx, setDx] = useState("0");
  const [dy, setDy] = useState("0");
  const [destination, setDestination] = useState<{
    map: AssistMap;
    x: number;
    y: number;
    direction: number;
    gameSessionId?: string;
  } | null>(null);
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const movement = state.movement;
  const actions = supportedAssistActions(state);
  const selectedMap = maps.find((map) => String(map.id) === mapId);
  const visibleMaps = maps.filter((map) =>
    `${map.id} ${map.name}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setMaps([]);
    setDestination(null);
    void (async () => {
      try {
        const cached = await api.getRecollection({ projectId });
        const scan = cached.scan ?? (await api.scanRecollection({ projectId }));
        if (active) setMaps(scan.maps);
      } catch (failure) {
        if (active) setError(errorMessage(failure));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId, mapReload]);

  useEffect(() => {
    setDestination(null);
    setDx("0"); setDy("0"); setMapId(""); setX(""); setY("");
  }, [state.gameSessionId]);

  async function send(command: Command) {
    setError("");
    return onCommand({ ...command, params: { gameSessionId: state.gameSessionId, ...command.params } });
  }
  function prepareTransfer(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!selectedMap) return;
    try {
      const target = assistDestination(selectedMap, x, y);
      setDestination({
        map: selectedMap,
        x: target.x,
        y: target.y,
        direction: Number(direction),
        gameSessionId: state.gameSessionId,
      });
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  return (
    <>
      <section className="panel assist-exploration">
        <div className="panel-heading">
          <h2>
            <Compass size={18} />{tr("移动与探索")}</h2>
          {actions.has("restoreMovement") && (
            <Button
              disabled={busy}
              onClick={() => void send({ action: "restoreMovement" })}
            >
              <RotateCcw size={15} />{tr("恢复移动设置")}</Button>
          )}
        </div>
        {movement ? (
          <div className="assist-location">
            <MapPin size={20} />
            <div>
              <strong>{movement.mapName || tr`地图 #${movement.mapId}`}</strong>
              <span>{tr("地图 #")}{movement.mapId} · X {movement.x} / Y {movement.y}
              </span>
            </div>
            <span className="tag">{tr("当前地点")}</span>
          </div>
        ) : (
          <p className="muted">{tr("从工作台启动成品并进入地图后，显示角色位置与移动设置。")}</p>
        )}
        {movement && (
          <div className="assist-exploration-controls">
            {actions.has("setThrough") && (
              <label className="toggle-line">
                <div>
                  <strong>{tr("穿墙")}</strong>
                  <small>{tr("开启后可通过地形与阻挡物")}</small>
                </div>
                <input
                  type="checkbox"
                  aria-label={tr("穿墙")}
                  role="switch"
                  checked={movement.through}
                  disabled={busy}
                  onChange={(event) =>
                    void send({
                      action: "setThrough",
                      value: event.target.checked,
                    })
                  }
                />
              </label>
            )}
            {actions.has("setEncounter") && (
              <label className="toggle-line">
                <div>
                  <strong>{tr("随机遇敌")}</strong>
                  <small>{tr("开启后，行走时可触发随机战斗")}</small>
                </div>
                <input
                  type="checkbox"
                  aria-label={tr("随机遇敌")}
                  role="switch"
                  checked={movement.encounterEnabled}
                  disabled={busy}
                  onChange={(event) =>
                    void send({
                      action: "setEncounter",
                      value: event.target.checked,
                    })
                  }
                />
              </label>
            )}
            {actions.has("setMoveSpeed") && (
              <label className="field assist-speed">
                <span>{tr("移动速度 ")}<small>{tr("当前档位 ")}{movement.moveSpeed}</small>
                </span>
                <select
                  aria-label={tr("移动速度")}
                  value={movement.moveSpeed}
                  disabled={busy}
                  onChange={(event) =>
                    void send({
                      action: "setMoveSpeed",
                      value: Number(event.target.value),
                    })
                  }
                >
                  {assistMoveSpeeds.map((speed) => (
                    <option key={speed.value} value={speed.value}>
                      {speed.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        <p className="assist-hint muted">{tr("修改立即生效。“恢复移动设置”还原本次辅助改过的设置，保留游戏随后改过的值。")}</p>
      </section>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      <div className="assist-travel-grid">
        {actions.has("jump") && (
          <section className="panel">
            <div className="panel-heading">
              <h2>{tr("向指定方向跳跃")}</h2>
              <span className="tag">{tr("以格为单位")}</span>
            </div>
            <p className="assist-section-intro">{tr("从当前位置按横向、纵向格数跳跃。")}</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const jumpX = Number(dx),
                  jumpY = Number(dy);
                if (
                  !Number.isInteger(jumpX) ||
                  !Number.isInteger(jumpY) ||
                  !dx.trim() ||
                  !dy.trim()
                ) {
                  setError(tr("横向与纵向都需要填写整数。向右 2 格填 2，向上 1 格填 -1。"));
                  return;
                }
                void send({ action: "jump", params: { dx: jumpX, dy: jumpY } });
              }}
            >
              <div className="assist-coordinate-fields">
                <label className="field">
                  <span>{tr("横向格数")}</span>
                  <input
                    aria-label={tr("跳跃横向格数")}
                    type="number"
                    step="1"
                    min="-20"
                    max="20"
                    value={dx}
                    onChange={(event) => setDx(event.target.value)}
                    required
                  />
                </label>
                <label className="field">
                  <span>{tr("纵向格数")}</span>
                  <input
                    aria-label={tr("跳跃纵向格数")}
                    type="number"
                    step="1"
                    min="-20"
                    max="20"
                    value={dy}
                    onChange={(event) => setDy(event.target.value)}
                    required
                  />
                </label>
              </div>
              <p className="assist-hint muted">{tr("左、上填负数，右、下填正数；每个方向限 -20 到 20 格。")}</p>
              <Button
                type="submit"
                disabled={
                  busy ||
                  !movement?.canTransfer ||
                  (Number(dx) === 0 && Number(dy) === 0)
                }
              >{tr("执行跳跃")}</Button>
            </form>
          </section>
        )}
        {actions.has("transfer") && (
          <section className="panel">
            <div className="panel-heading">
              <h2>{tr("地图传送")}</h2>
              <span className="tag">
                {loading ? tr("读取地图中") : tr`${maps.length} 张地图`}
              </span>
            </div>
            {!loading && maps.length === 0 && (
              <Button
                disabled={busy}
                onClick={() => setMapReload((current) => current + 1)}
              >{tr("重新读取地图")}</Button>
            )}
            <form onSubmit={prepareTransfer}>
              <label className="search-field assist-search">
                <Search size={17} />
                <input
                  aria-label={tr("搜索传送地图")}
                  placeholder={tr("搜索地图名称或编号")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label className="field">
                <span>{tr("目标地图")}</span>
                <select
                  aria-label={tr("目标地图")}
                  value={mapId}
                  disabled={loading || busy}
                  onChange={(event) => {
                    setMapId(event.target.value);
                    setX("");
                    setY("");
                  }}
                >
                  <option value="">{tr("选择目标地图")}</option>
                  {selectedMap &&
                    !visibleMaps.some((map) => map.id === selectedMap.id) && (
                      <option value={selectedMap.id}>
                        {selectedMap.name} · #{selectedMap.id}
                      </option>
                    )}
                  {visibleMaps.map((map) => (
                    <option key={map.id} value={map.id}>
                      {map.name || tr("未命名地图")} · #{map.id} · {map.width}×
                      {map.height}
                    </option>
                  ))}
                </select>
              </label>
              {selectedMap && (
                <>
                  <div className="assist-coordinate-fields">
                    <label className="field">
                      <span>{tr("X 坐标 ")}<small>0–{selectedMap.width - 1}</small>
                      </span>
                      <input
                        aria-label={tr("传送 X 坐标")}
                        type="number"
                        min="0"
                        max={selectedMap.width - 1}
                        step="1"
                        value={x}
                        onChange={(event) => setX(event.target.value)}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>{tr("Y 坐标 ")}<small>0–{selectedMap.height - 1}</small>
                      </span>
                      <input
                        aria-label={tr("传送 Y 坐标")}
                        type="number"
                        min="0"
                        max={selectedMap.height - 1}
                        step="1"
                        value={y}
                        onChange={(event) => setY(event.target.value)}
                        required
                      />
                    </label>
                  </div>
                  <label className="field">
                    <span>{tr("抵达朝向")}</span>
                    <select
                      aria-label={tr("抵达朝向")}
                      value={direction}
                      onChange={(event) => setDirection(event.target.value)}
                    >
                      <option value="2">{tr("向下")}</option>
                      <option value="4">{tr("向左")}</option>
                      <option value="6">{tr("向右")}</option>
                      <option value="8">{tr("向上")}</option>
                    </select>
                  </label>
                </>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !selectedMap || !movement?.canTransfer}
              >{tr("下一步：确认传送")}</Button>
              {movement && !movement.canTransfer && (
                <p className="assist-hint muted">{tr("结束对话或战斗，回到可行走的地图后再跳跃或传送。")}</p>
              )}
            </form>
          </section>
        )}
      </div>
      {destination && (
        <Modal
          title={tr("传送到指定地点")}
          onClose={() => setDestination(null)}
          busy={busy}
        >
          <p className="dialog-intro">{tr("前往 ")}{destination.map.name} · X {destination.x} / Y {destination.y}{tr("。确认后立即传送，跨地图会离开当前场景。")}</p>
          <div className="dialog-actions">
            <Button disabled={busy} onClick={() => setDestination(null)}>{tr("取消")}</Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!movement?.canTransfer}
              onClick={() => {
                const activeProject = projectId;
                void send({
                  action: "transfer",
                  params: {
                    mapId: destination.map.id,
                    x: destination.x,
                    y: destination.y,
                    direction: destination.direction,
                    gameSessionId: destination.gameSessionId,
                  },
                }).then((ok) => {
                  if (ok && currentProject.current === activeProject)
                    setDestination(null);
                });
              }}
            >{tr("传送到这里")}</Button>
          </div>
        </Modal>
      )}
    </>
  );
}
