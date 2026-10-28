// Neutral codec fixture for testing the reflection/record-preservation contract.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Yukar.Common
{
    public class Catalog
    {
        public static Catalog sInstance;
        public const short SIGNATURE_LAYOUT = 4;
        private Rom.GameSettings gameSettings;
        private readonly List<Rom.RomItem> items = new List<Rom.RomItem>();
        public Catalog() { }
        public int load(Stream stream, bool ignored)
        {
            var reader = new BinaryReader(stream, Encoding.UTF8);
            reader.ReadBytes(17);
            while (stream.Position < stream.Length)
            {
                int size = reader.ReadInt32(); short type = reader.ReadInt16();
                var raw = reader.ReadBytes(size);
                Rom.RomItem item = type == 1 ? (Rom.RomItem)new Rom.Hero() : type == 2 ? (Rom.RomItem)new Rom.Script() : type == 3 ? (Rom.RomItem)new Rom.GameSettings() : type == SIGNATURE_LAYOUT ? new Rom.LayoutProperties() : null;
                if (item == null) continue;
                using (var input = new BinaryReader(new MemoryStream(raw), Encoding.UTF8)) item.load(input);
                items.Add(item);
                if (item is Rom.GameSettings) gameSettings = (Rom.GameSettings)item;
            }
            return 0;
        }
        public List<Rom.RomItem> getFullList() { return items; }
        public int loadLayoutSgr(Stream stream, bool ignored)
        {
            int result = load(stream, ignored);
            foreach (var item in items)
                if (item is Rom.LayoutProperties) ((Rom.LayoutProperties)item).x *= 2.0f / 3.0f;
            return result;
        }
    }
}

namespace Yukar.Common.Rom
{
    public class RomItem
    {
        public Guid guId;
        public string name;
        public virtual void load(BinaryReader reader) { guId = new Guid(reader.ReadBytes(16)); name = reader.ReadString(); }
        public virtual void save(BinaryWriter writer) { writer.Write(guId.ToByteArray()); writer.Write(name); }
    }
    public class Hero : RomItem
    {
        public string description;
        public string JointBoneName = "R_itemhook";
        public Formula formula = new Formula();
        public TagDataManager tags = new TagDataManager();
        public int hp;
        public override void load(BinaryReader reader) { base.load(reader); description = reader.ReadString(); hp = reader.ReadInt32(); }
        public override void save(BinaryWriter writer) { base.save(writer); writer.Write(description); writer.Write(hp); }
    }
    public class Formula { public string Text = "a.hp + b.hp"; }
    public class TagDataManager { public string name = "#cam_default"; }
    public class GameSettings : RomItem
    {
        public class Glossary { public string battle_attack; }
        public Glossary glossary = new Glossary();
        public override void load(BinaryReader reader) { base.load(reader); glossary.battle_attack = reader.ReadString(); }
        public override void save(BinaryWriter writer) { base.save(writer); writer.Write(glossary.battle_attack); }
    }
    public class LayoutProperties : RomItem
    {
        public string text;
        public float x;
        public override void load(BinaryReader reader) { base.load(reader); text = reader.ReadString(); x = reader.ReadSingle(); }
        public override void save(BinaryWriter writer) { base.save(writer); writer.Write(text); writer.Write(x); }
    }
    public class Script : RomItem
    {
        public class StringAttr { public string value; }
        public class Command
        {
            public enum FuncType { MESSAGE, JUMP, CHOICES }
            public FuncType type;
            public List<StringAttr> attrList = new List<StringAttr>();
        }
        public List<Command> commands = new List<Command>();
        public override void load(BinaryReader reader)
        {
            base.load(reader);
            int count = reader.ReadInt32();
            for (int index = 0; index < count; index++)
            {
                var command = new Command { type = (Command.FuncType)reader.ReadInt32() };
                command.attrList.Add(new StringAttr { value = reader.ReadString() }); commands.Add(command);
            }
        }
        public override void save(BinaryWriter writer)
        {
            base.save(writer); writer.Write(commands.Count);
            foreach (var command in commands) { writer.Write((int)command.type); writer.Write(command.attrList[0].value); }
        }
    }
}
