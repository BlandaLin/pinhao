// Native resource serialization runs in a separate process using the game's own codec.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class YukarResources
{
    private const BindingFlags Flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
    private static readonly Regex DisplayField = new Regex("name|title|description|text|message|caption|term|label|credit|pronoun", RegexOptions.IgnoreCase);
    private static readonly Regex InternalField = new Regex("path|file|font|template|shader|motion|bone|variable|switch|category|script(?!ion)|format|guid|color|searchtag", RegexOptions.IgnoreCase);
    private static readonly HashSet<string> DisplayCommands = new HashSet<string>(new[] {
        "MESSAGE", "DIALOGUE", "CHOICES", "CHOICE", "SPTEXT", "TELOP", "TEXT_INPUT", "INPUT_TEXT",
        "CHANGE_HERO_NAME", "CHG_HERO_NAME", "HERO_NAME", "CHANGE_NAME", "SHOW_TEXT", "SHOW_MESSAGE"
    });
    private static string SettingsPath;
    private static object TemplateSettings;
    private static short LayoutSignature = short.MinValue;

    private sealed class Slot
    {
        public object Owner;
        public FieldInfo Field;
        public int Index = -1;
        public string Path, Source, Kind, Item, Command;
        public void Set(string value)
        {
            if (Index >= 0) ((IList)Owner)[Index] = value;
            else Field.SetValue(Owner, value);
        }
    }

    private static string Value(object owner, string field)
    {
        var info = owner.GetType().GetField(field, Flags);
        var value = info == null ? null : info.GetValue(owner);
        return value == null ? "" : value.ToString();
    }

    private static IEnumerable<FieldInfo> Fields(Type type)
    {
        var fields = new List<FieldInfo>();
        for (var current = type; current != null && current.Namespace != "System"; current = current.BaseType)
            fields.AddRange(current.GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly));
        return fields.OrderBy(field => field.Name, StringComparer.Ordinal);
    }

    private static string FieldName(FieldInfo field)
    {
        return field.Name.StartsWith("<") && field.Name.EndsWith(">k__BackingField") ? field.Name.Substring(1, field.Name.IndexOf('>') - 1) : field.Name;
    }

    private static bool Visible(string text)
    {
        if (string.IsNullOrWhiteSpace(text) || text.IndexOf('\0') >= 0) return false;
        Guid guid;
        if (Guid.TryParse(text, out guid)) return false;
        if (Regex.IsMatch(text, @"^(?:[a-z]+://|[A-Za-z]:[\\/])|\.(?:png|jpe?g|ogg|wav|mp3|fbx|obj|dll|exe|ttf|otf|cs)$", RegexOptions.IgnoreCase)) return false;
        return true;
    }

    private static void Walk(object value, string path, string item, List<Slot> slots, HashSet<object> seen, int depth)
    {
        if (value == null || depth > 24 || value is string || value.GetType().IsValueType || !seen.Add(value)) return;
        // Formula.Text is executable arithmetic; editor tags and bone names are resource identities.
        if (value.GetType().FullName == "Yukar.Common.Rom.Formula" || value.GetType().FullName == "Yukar.Common.Rom.TagDataManager") return;
        var list = value as IList;
        if (list != null)
        {
            var array = value as Array;
            if (array != null && array.Rank != 1) return;
            for (int index = 0; index < list.Count; index++) Walk(list[index], path + "/" + index, item, slots, seen, depth + 1);
            return;
        }
        var dictionary = value as IDictionary;
        if (dictionary != null)
        {
            foreach (DictionaryEntry entry in dictionary) Walk(entry.Value, path + "/" + entry.Key, item, slots, seen, depth + 1);
            return;
        }
        if (!value.GetType().FullName.StartsWith("Yukar.Common.Rom.", StringComparison.Ordinal) || value.GetType().Name == "Folder") return;
        foreach (var field in Fields(value.GetType()))
        {
            var child = field.GetValue(value);
            var next = path + "/" + field.Name;
            var name = FieldName(field);
            bool display = value.GetType().Name == "Glossary" || DisplayField.IsMatch(name) && !InternalField.IsMatch(name);
            if (value.GetType().Name.Contains("LayoutNode") && (name == "Name" || name == "USName" || name == "PreviewTexts")) display = false;
            if (value.GetType().Name == "MenuItem") display = name == "text";
            if (field.FieldType == typeof(string))
            {
                string source = child as string;
                if (display && Visible(source))
                    slots.Add(new Slot { Owner = value, Field = field, Path = next, Source = source, Kind = field.Name == "name" ? "display_name" : "database_text", Item = item });
            }
            else if (child is IList && display)
            {
                var strings = (IList)child;
                for (int index = 0; index < strings.Count; index++)
                {
                    var source = strings[index] as string;
                    if (Visible(source)) slots.Add(new Slot { Owner = child, Index = index, Path = next + "/" + index, Source = source, Kind = "ui_text", Item = item });
                    else Walk(strings[index], next + "/" + index, item, slots, seen, depth + 1);
                }
            }
            else Walk(child, next, item, slots, seen, depth + 1);
        }
    }

    private static HashSet<string> RecordIds(byte[] original)
    {
        var ids = new HashSet<string>();
        using (var reader = new BinaryReader(new MemoryStream(original)))
        {
            if (original.Length < 17 || Encoding.ASCII.GetString(original, 0, 5) != "YUKAR") throw new InvalidDataException("Unknown native resource framing");
            reader.BaseStream.Position = 17;
            while (reader.BaseStream.Position < original.Length)
            {
                if (original.Length - reader.BaseStream.Position < 6) throw new InvalidDataException("Truncated native resource record");
                var size = reader.ReadInt32(); var signature = reader.ReadInt16();
                if (size < 0 || size > original.Length - reader.BaseStream.Position) throw new InvalidDataException("Invalid native resource record size");
                var raw = reader.ReadBytes(size);
                if (signature == LayoutSignature) ids.Add("@layout");
                else if (raw.Length >= 16) ids.Add(new Guid(raw.Take(16).ToArray()).ToString());
            }
        }
        return ids;
    }

    private static List<object> AllItems(object catalog)
    {
        return ((IEnumerable)catalog.GetType().GetMethod("getFullList").Invoke(catalog, null)).Cast<object>().ToList();
    }

    private static string ItemId(object item) { return item.GetType().Name == "LayoutProperties" ? "@layout" : Value(item, "guId"); }

    private static List<Slot> Collect(object catalog, HashSet<string> records)
    {
        var slots = new List<Slot>();
        var items = AllItems(catalog);
        var guids = new HashSet<string>();
        foreach (var item in items)
        {
            var type = item.GetType().Name;
            var guid = ItemId(item);
            if (!records.Contains(guid)) continue;
            if (guid == "" || !guids.Add(guid)) throw new InvalidDataException("Native resource contains missing or duplicate object identifiers");
            if (type == "Script")
            {
                var commandsField = item.GetType().GetField("commands", Flags);
                if (commandsField == null) throw new InvalidDataException("Script command API is unavailable");
                var commands = (IList)commandsField.GetValue(item);
                for (int index = 0; index < commands.Count; index++)
                {
                    var command = commands[index];
                    var name = Value(command, "type");
                    if (!DisplayCommands.Contains(name)) continue;
                    var attrs = (IList)command.GetType().GetField("attrList", Flags).GetValue(command);
                    for (int attr = 0; attr < attrs.Count; attr++)
                    {
                        var field = attrs[attr].GetType().GetField("value", Flags);
                        if (field == null || field.FieldType != typeof(string)) continue;
                        var source = field.GetValue(attrs[attr]) as string;
                        if (Visible(source)) slots.Add(new Slot { Owner = attrs[attr], Field = field, Path = guid + "/commands/" + index + "/attrList/" + attr + "/value", Source = source, Kind = name.Contains("CHOICE") ? "choice" : "dialogue", Item = guid, Command = name });
                    }
                }
            }
            else if (type == "Map")
            {
                var field = item.GetType().GetField("name", Flags);
                var source = field == null ? null : field.GetValue(item) as string;
                if (Visible(source)) slots.Add(new Slot { Owner = item, Field = field, Path = guid + "/name", Source = source, Kind = "display_name", Item = guid });
            }
            else if (type != "Event" && type != "Folder" && type != "ExtraChunk" && type != "Camera" && type != "RenderSettings" && type != "Effect" && !item.GetType().FullName.StartsWith("Yukar.Common.Resource.", StringComparison.Ordinal))
                Walk(item, guid, guid, slots, new HashSet<object>(), 0);
        }
        return slots;
    }

    private static object Load(Type type, string path)
    {
        object catalog;
        var ctor = type.GetConstructor(Type.EmptyTypes);
        catalog = ctor != null ? ctor.Invoke(null) : type.GetConstructor(new[] { typeof(bool) }).Invoke(new object[] { false });
        var instance = type.GetField("sInstance", Flags);
        if (instance != null) instance.SetValue(null, catalog);
        var settings = type.GetField("gameSettings", Flags);
        if (settings != null && TemplateSettings != null) settings.SetValue(catalog, TemplateSettings);
        // loadLayoutSgr imports system layouts and can rescale authored geometry.
        // Resource files, including Layout, require the ordinary catalog loader.
        var load = type.GetMethods(Flags).Where(method => method.Name == "load").FirstOrDefault(method => {
            var parameters = method.GetParameters();
            return parameters.Length >= 2 && parameters[0].ParameterType == typeof(Stream) && (parameters[1].ParameterType == typeof(bool) || parameters[1].ParameterType.IsEnum);
        });
        if (load == null) throw new InvalidDataException("Native Catalog.load(Stream) API is unavailable");
        var args = load.GetParameters().Select(parameter => parameter.ParameterType.IsEnum ? Enum.ToObject(parameter.ParameterType, 0) : parameter.ParameterType == typeof(bool) ? (object)false : null).ToArray();
        using (var stream = File.OpenRead(path)) { args[0] = stream; load.Invoke(catalog, args); }
        return catalog;
    }

    private static byte[] SaveItem(object item)
    {
        var save = item.GetType().GetMethod("save", new[] { typeof(BinaryWriter) });
        if (save == null) throw new InvalidDataException("Native record save(BinaryWriter) API is unavailable");
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream, Encoding.UTF8)) { save.Invoke(item, new object[] { writer }); writer.Flush(); return stream.ToArray(); }
    }

    private static byte[] Rewrite(object catalog, byte[] original, HashSet<string> writable, bool changed, Dictionary<string, string> rejected = null)
    {
        if (original.Length < 17 || Encoding.ASCII.GetString(original, 0, 5) != "YUKAR") throw new InvalidDataException("Unknown native resource framing");
        var items = AllItems(catalog).ToDictionary(ItemId);
        var found = new HashSet<string>();
        using (var input = new BinaryReader(new MemoryStream(original)))
        using (var output = new MemoryStream())
        using (var writer = new BinaryWriter(output, Encoding.UTF8))
        {
            writer.Write(input.ReadBytes(17));
            while (input.BaseStream.Position < original.Length)
            {
                if (original.Length - input.BaseStream.Position < 6) throw new InvalidDataException("Truncated native record header");
                var length = input.ReadInt32();
                var signature = input.ReadInt16();
                if (length < 0 || length > original.Length - input.BaseStream.Position) throw new InvalidDataException("Invalid native record length");
                var raw = input.ReadBytes(length);
                var guid = signature == LayoutSignature ? "@layout" : raw.Length >= 16 ? new Guid(raw.Take(16).ToArray()).ToString() : "";
                if (writable.Contains(guid))
                {
                    if (!items.ContainsKey(guid) || !found.Add(guid)) throw new InvalidDataException("Missing or duplicated native object record");
                    byte[] serialized = raw;
                    try
                    {
                      if (items[guid].GetType().Name == "Map")
                      {
                        // Map loaders upgrade unrelated geometry metadata. Replace only the
                        // leading native name string and retain the entire geometry payload.
                        using (var mapInput = new BinaryReader(new MemoryStream(raw), Encoding.UTF8))
                        using (var mapOutput = new MemoryStream())
                        using (var mapWriter = new BinaryWriter(mapOutput, Encoding.UTF8))
                        {
                            mapWriter.Write(mapInput.ReadBytes(16));
                            var oldName = mapInput.ReadString();
                            var newName = Value(items[guid], "name");
                            if (!changed && oldName != newName) throw new InvalidDataException("Map display name readback differs");
                            mapWriter.Write(newName);
                            mapWriter.Write(mapInput.ReadBytes(raw.Length - (int)mapInput.BaseStream.Position));
                            mapWriter.Flush(); serialized = mapOutput.ToArray();
                        }
                      }
                      else serialized = SaveItem(items[guid]);
                      if (!changed && !serialized.SequenceEqual(raw))
                      {
                          var first = Enumerable.Range(0, Math.Min(raw.Length, serialized.Length)).FirstOrDefault(index => raw[index] != serialized[index]);
                          if (serialized.Take(Math.Min(raw.Length, serialized.Length)).SequenceEqual(raw.Take(Math.Min(raw.Length, serialized.Length)))) first = Math.Min(raw.Length, serialized.Length);
                          throw new InvalidDataException("Native record no-change serialization differs: " + guid + " (" + raw.Length + "/" + serialized.Length + ", first=" + first + ")");
                      }
                    }
                    catch (Exception exception)
                    {
                        if (changed || rejected == null) throw;
                        while (exception.InnerException != null) exception = exception.InnerException;
                        rejected.Add(guid, exception.GetType().Name + ": " + exception.Message);
                        // A rejected object is not writable. Its native bytes remain the baseline.
                        serialized = raw;
                    }
                    raw = serialized;
                }
                writer.Write(raw.Length); writer.Write(signature); writer.Write(raw);
            }
            if (!found.SetEquals(writable)) throw new InvalidDataException("Native object bindings are absent from resource records: " + string.Join(",", writable.Except(found).Take(3)));
            writer.Flush();
            return output.ToArray();
        }
    }

    private static void Run(string input, string output)
    {
        var job = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(input, Encoding.UTF8));
        var assemblyPath = Path.GetFullPath((string)job["assembly"]);
        var folder = Path.GetDirectoryName(assemblyPath);
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e) {
            var file = Path.Combine(folder, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(file) ? Assembly.LoadFrom(file) : null;
        };
        var assembly = Assembly.LoadFrom(assemblyPath);
        SettingsPath = new[] { Path.Combine(folder, "GameSettings.rbr"), Path.Combine(folder, "GameSettings.sgr") }.FirstOrDefault(File.Exists);
        var resourceType = assembly.GetType("Yukar.Common.Resource.ResourceItem");
        if (resourceType != null)
        {
            var clipboard = resourceType.GetField("sClipboardLoad", Flags);
            if (clipboard != null) clipboard.SetValue(null, true);
            var mode = resourceType.GetField("sCurrentSourceMode", Flags);
            if (mode != null && Enum.IsDefined(mode.FieldType, "RES_USER")) mode.SetValue(null, Enum.Parse(mode.FieldType, "RES_USER"));
        }
        var type = assembly.GetType("Yukar.Common.Catalog", true);
        var layoutSignature = type.GetField("SIGNATURE_LAYOUT", Flags);
        if (layoutSignature != null) LayoutSignature = Convert.ToInt16(layoutSignature.GetValue(null));
        if (SettingsPath != null)
        {
            var settingsCatalog = Load(type, SettingsPath);
            var settings = type.GetField("gameSettings", Flags);
            if (settings != null) TemplateSettings = settings.GetValue(settingsCatalog);
        }
        var results = new List<object>();
        foreach (Dictionary<string, object> resource in (IEnumerable)job["resources"])
        {
            var path = (string)resource["file"];
            File.WriteAllText(output + ".progress", Path.GetFileName(path), Encoding.UTF8);
            var catalog = Load(type, path);
            var original = File.ReadAllBytes(path);
            var slots = Collect(catalog, RecordIds(original));
            var writable = new HashSet<string>(slots.Select(slot => slot.Item));
            var rejected = new Dictionary<string, string>();
            var roundtrip = Rewrite(catalog, original, writable, false, rejected);
            if (!original.SequenceEqual(roundtrip)) throw new InvalidDataException("Native no-change resource serialization differs: " + Path.GetFileName(path));
            if (slots.Select(slot => slot.Path).Distinct().Count() != slots.Count) throw new InvalidDataException("Duplicate display binding");
            var pending = rejected.Select(entry => new { item = entry.Key, reason = entry.Value,
                candidateCount = slots.Count(slot => slot.Item == entry.Key),
                paths = slots.Where(slot => slot.Item == entry.Key).Select(slot => slot.Path).ToArray() }).ToArray();
            slots = slots.Where(slot => !rejected.ContainsKey(slot.Item)).ToList();
            if (resource.ContainsKey("updates"))
            {
                var updates = (Dictionary<string, object>)resource["updates"];
                var byPath = slots.ToDictionary(slot => slot.Path);
                foreach (var update in updates)
                {
                    Slot slot;
                    if (!byPath.TryGetValue(update.Key, out slot) || !(update.Value is string)) throw new InvalidDataException("Unknown native display binding: " + update.Key);
                    slot.Set((string)update.Value);
                }
                var target = (string)resource["output"];
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                var changed = new HashSet<string>(updates.Keys.Select(key => byPath[key].Item));
                File.WriteAllBytes(target, Rewrite(catalog, original, changed, true));
                if (updates.Count > 0)
                {
                    var actual = Collect(Load(type, target), RecordIds(File.ReadAllBytes(target))).ToDictionary(slot => slot.Path, slot => slot.Source);
                    foreach (var slot in slots)
                    {
                        var expected = updates.ContainsKey(slot.Path) ? (string)updates[slot.Path] : slot.Source;
                        if (!actual.ContainsKey(slot.Path) || actual[slot.Path] != expected) throw new InvalidDataException("Native display readback mismatch: " + slot.Path);
                    }
                }
            }
            results.Add(new { file = resource["name"], byteIdentical = true, unsupportedRecords = pending,
                entries = slots.Select(slot => new { path = slot.Path, source = slot.Source, kind = slot.Kind, item = slot.Item, command = slot.Command }).ToArray() });
        }
        File.WriteAllText(output, Json.Serialize(new { resources = results }), new UTF8Encoding(false));
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try { Run(args[0], args[1]); return 0; }
        catch (Exception exception)
        {
            while (exception.InnerException != null) exception = exception.InnerException;
            Console.Error.WriteLine(exception.GetType().Name + ": " + exception.Message);
            Console.Error.WriteLine(exception.StackTrace);
            return 1;
        }
    }
}
