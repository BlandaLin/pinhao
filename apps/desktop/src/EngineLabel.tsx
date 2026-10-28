import { Gamepad2 } from "lucide-react";

const icons: Record<string, string> = {
  rpgmaker: "rpgmaker.webp",
  godot: "godot.svg",
  unity: "unity.svg",
  renpy: "renpy.png",
};

function engineFamily(engine: string) {
  const key = engine.toLowerCase().replace(/[\s_\/'’.-]/g, "");
  if (key.includes("rpgmaker") || ["mv", "mz", "xp", "vx", "vxace", "rpg2000", "rpg2003"].includes(key)) return "rpgmaker";
  if (key.includes("godot")) return "godot";
  if (key.includes("unity")) return "unity";
  if (key.includes("renpy")) return "renpy";
  return "other";
}

export default function EngineLabel({ engine, label }: { engine: string; label?: string }) {
  const family = engineFamily(engine);
  const icon = icons[family];
  return (
    <span className="engine-label" data-engine={family}>
      {icon ? <img className="engine-icon" src={`./engines/${icon}`} alt="" aria-hidden="true" width="22" height="22" />
        : <Gamepad2 className="engine-icon" size={20} aria-hidden="true" />}
      <span className="engine-label-text">{label || engine}</span>
    </span>
  );
}
