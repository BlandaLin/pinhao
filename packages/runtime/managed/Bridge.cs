using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;

namespace Pinhao.ManagedAssist
{
    public static class Bridge
    {
        const int MaxRoots = 1024, MaxNodes = 4096, MaxBindings = 2000;
        class ReferenceComparer : IEqualityComparer<object>
        {
            public new bool Equals(object left, object right) { return Object.ReferenceEquals(left, right); }
            public int GetHashCode(object value) { return RuntimeHelpers.GetHashCode(value); }
        }
        class Binding
        {
            public object Owner, Key;
            public FieldInfo Field;
            public string Name, Label, Store, Type;
            public object Get() { return Field != null ? Field.GetValue(Owner) : Owner is IDictionary ? ((IDictionary)Owner)[Key] : ((IList)Owner)[(int)Key]; }
            public void Set(object value) { if (Field != null) Field.SetValue(Owner, value); else if (Owner is IDictionary) ((IDictionary)Owner)[Key] = value; else ((IList)Owner)[(int)Key] = value; }
        }
        static readonly Dictionary<int, WeakReference> Roots = new Dictionary<int, WeakReference>();
        static readonly Queue<int> RootOrder = new Queue<int>();
        static readonly Dictionary<string, string> Completed = new Dictionary<string, string>();
        static readonly Queue<string> CompletedOrder = new Queue<string>();
        static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
        static string DirectoryPath, Token, BackupPath, Engine;
        static readonly string Session = Guid.NewGuid().ToString("N");
        static long Last;
        static bool Busy, Disabled;
        static readonly Dictionary<string, bool> CatalogNames = new Dictionary<string, bool>();
        static readonly List<string> CatalogLimits = new List<string>();
        static bool RootsTruncated;
        static readonly Encoding Utf8 = new UTF8Encoding(false);

        static void Limit(string value) { if (!CatalogLimits.Contains(value)) CatalogLimits.Add(value); }

        public static void Tick(object root, string engine)
        {
            if (Busy || Disabled) return;
            bool entered = false;
            try
            {
                if (!Configure(engine)) return;
                if (root != null)
                {
                    int id = RuntimeHelpers.GetHashCode(root);
                    if (!Roots.ContainsKey(id))
                    {
                        while (RootOrder.Count >= MaxRoots) { Roots.Remove(RootOrder.Dequeue()); RootsTruncated = true; }
                        RootOrder.Enqueue(id);
                    }
                    Roots[id] = new WeakReference(root);
                }
                if (DateTime.UtcNow.Ticks - Last < TimeSpan.TicksPerMillisecond * 180) return;
                Last = DateTime.UtcNow.Ticks;
                Busy = true; entered = true;
                Poll();
            }
            catch { /* Assistance stays separate from the game's frame execution. */ }
            finally { if (entered) Busy = false; }
        }

        static bool Configure(string engine)
        {
            if (DirectoryPath != null) { if (System.IO.Directory.Exists(DirectoryPath)) return true; Disabled = true; return false; }
            string directory = Environment.GetEnvironmentVariable("PINHAO_ASSIST_DIR");
            string token = Environment.GetEnvironmentVariable("PINHAO_ASSIST_TOKEN");
            string backup = Environment.GetEnvironmentVariable("PINHAO_ASSIST_BACKUP_DIR");
            if (String.IsNullOrEmpty(directory) || String.IsNullOrEmpty(token)) { Disabled = true; return false; }
            if (!Path.IsPathRooted(directory) || !System.IO.Directory.Exists(directory) || token.Length < 32) return false;
            if (String.IsNullOrEmpty(backup)) backup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pinhao-managed-assist-backups");
            DirectoryPath = directory; Token = token; BackupPath = backup; Engine = engine;
            return true;
        }

        static string Scalar(object value)
        {
            if (value is bool) return "boolean";
            if (value is string) return ((string)value).Length <= 2000 ? "string" : null;
            if (value != null && (value.GetType().IsPrimitive || value is decimal) && !(value is char))
            {
                double number;
                try { number = Convert.ToDouble(value, Invariant); } catch { return null; }
                return !Double.IsNaN(number) && !Double.IsInfinity(number) && Math.Abs(number) <= 9007199254740991d ? "number" : null;
            }
            return null;
        }

        static void Add(List<Binding> result, object owner, object key, FieldInfo field, object value, string label, string store)
        {
            string type = Scalar(value);
            if (type == null) return;
            if (result.Count >= MaxBindings) { Limit("bindings"); return; }
            string identity = RuntimeHelpers.GetHashCode(owner).ToString("x", Invariant);
            string suffix = field != null ? field.DeclaringType.FullName + "." + field.Name : Convert.ToString(key, Invariant);
            string name = identity + ":" + suffix;
            if (CatalogNames.ContainsKey(name)) return;
            CatalogNames.Add(name, true);
            result.Add(new Binding { Owner = owner, Key = key, Field = field, Name = name, Label = label, Store = store, Type = type });
        }

        static void Visit(object value, string label, string store, int depth, Dictionary<object, bool> seen, List<Binding> result)
        {
            if (value == null || Scalar(value) != null || value.GetType().IsValueType) return;
            if (depth > 5) { Limit("depth"); return; }
            if (result.Count >= MaxBindings) { Limit("bindings"); return; }
            if (seen.Count >= MaxNodes) { Limit("nodes"); return; }
            if (seen.ContainsKey(value)) return;
            seen.Add(value, true);
            IDictionary dict = value as IDictionary;
            if (dict != null)
            {
                Type collection = value.GetType();
                if (collection != typeof(Hashtable) && !(collection.IsGenericType && collection.GetGenericTypeDefinition() == typeof(Dictionary<,>))) return;
                if (dict.IsReadOnly) return;
                int count = 0;
                foreach (DictionaryEntry pair in dict)
                {
                    if (++count > 1000) { Limit("collection-items"); break; }
                    if (seen.Count >= MaxNodes) { Limit("nodes"); break; }
                    if (result.Count >= MaxBindings) { Limit("bindings"); break; }
                    if (!(pair.Key is string || pair.Key is int || pair.Key is Guid)) continue;
                    string key = Convert.ToString(pair.Key, Invariant);
                    Add(result, dict, pair.Key, null, pair.Value, label + "[" + key + "]", store);
                    Visit(pair.Value, label + "[" + key + "]", store, depth + 1, seen, result);
                }
                return;
            }
            IList list = value as IList;
            if (list != null)
            {
                Type collection = value.GetType();
                if (!collection.IsArray && !(collection.IsGenericType && collection.GetGenericTypeDefinition() == typeof(List<>))) return;
                if (list.IsReadOnly) return;
                if (list.Count > 1000) Limit("collection-items");
                for (int i = 0; i < Math.Min(list.Count, 1000); i++)
                {
                    if (seen.Count >= MaxNodes) { Limit("nodes"); break; }
                    if (result.Count >= MaxBindings) { Limit("bindings"); break; }
                    Add(result, list, i, null, list[i], label + "[" + i + "]", store);
                    Visit(list[i], label + "[" + i + "]", store, depth + 1, seen, result);
                }
                return;
            }
            Type type = value.GetType();
            if (type.Namespace != null && (type.Namespace.StartsWith("System") || type.Namespace.StartsWith("Microsoft") || type.Namespace.StartsWith("UnityEngine"))) return;
            if (type.Namespace != null && (type.Namespace.StartsWith("Yukar.Common.Rom") || type.Namespace.StartsWith("Yukar.Common.Resource"))) return;
            if (type.FullName == "Yukar.Common.Catalog") return;
            for (Type current = type; current != null && current != typeof(object); current = current.BaseType)
            {
                if (current.Namespace != null && current.Namespace.StartsWith("UnityEngine")) break;
                FieldInfo[] fields = current.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
                Array.Sort(fields, delegate(FieldInfo left, FieldInfo right) { return Priority(left.Name).CompareTo(Priority(right.Name)); });
                foreach (FieldInfo field in fields)
                {
                    if (seen.Count >= MaxNodes) { Limit("nodes"); break; }
                    if (result.Count >= MaxBindings) { Limit("bindings"); break; }
                    if (field.IsLiteral || field.FieldType.IsPointer || typeof(Delegate).IsAssignableFrom(field.FieldType)) continue;
                    object item;
                    try { item = field.GetValue(value); } catch { continue; }
                    string child = label + "." + field.Name;
                    if (!field.IsInitOnly) Add(result, value, null, field, item, child, store);
                    Visit(item, child, store, depth + 1, seen, result);
                }
            }
        }

        static int Priority(string name)
        {
            name = name.ToLowerInvariant();
            foreach (string key in new [] { "party", "hero", "actor", "player", "inventory", "money", "gold", "item" }) if (name.Contains(key)) return 0;
            return name.Contains("switch") || name.Contains("variable") || name.Contains("system") ? 10 : 5;
        }

        static List<Binding> Catalog()
        {
            var result = new List<Binding>();
            CatalogNames.Clear();
            CatalogLimits.Clear();
            if (RootsTruncated) Limit("roots");
            var seen = new Dictionary<object, bool>(new ReferenceComparer());
            var dead = new List<int>();
            foreach (var pair in Roots)
            {
                if (seen.Count >= MaxNodes) { Limit("nodes"); break; }
                if (result.Count >= MaxBindings) { Limit("bindings"); break; }
                object value = pair.Value.Target;
                if (value == null) { dead.Add(pair.Key); continue; }
                if (Engine != "Unity")
                {
                    if (value.GetType().FullName != "Yukar.Engine.GameMain") continue;
                    FieldInfo data = value.GetType().GetField("data", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                    if (data != null) { Visit(data.GetValue(value), "gameData", Engine, 0, seen, result); continue; }
                }
                Visit(value, value.GetType().Name, Engine, 0, seen, result);
                foreach (FieldInfo field in value.GetType().GetFields(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (field.IsLiteral || field.FieldType.IsPointer || typeof(Delegate).IsAssignableFrom(field.FieldType)) continue;
                    object item;
                    try { item = field.GetValue(null); } catch { continue; }
                    string label = value.GetType().Name + "." + field.Name;
                    if (!field.IsInitOnly) Add(result, value.GetType(), null, field, item, label, Engine);
                    Visit(item, label, Engine, 0, seen, result);
                }
            }
            foreach (int id in dead) Roots.Remove(id);
            return result;
        }

        static object Converted(object value, object before)
        {
            if (Scalar(value) != Scalar(before)) throw new InvalidOperationException("Keep the variable's original value type");
            if (before is string || before is bool) return value;
            double number = Convert.ToDouble(value, Invariant);
            Type type = before.GetType();
            bool integer = type != typeof(float) && type != typeof(double) && type != typeof(decimal);
            if (Double.IsNaN(number) || Double.IsInfinity(number) || Math.Abs(number) > 9007199254740991d || integer && Math.Truncate(number) != number)
                throw new InvalidOperationException("Enter a finite value within the variable's numeric range");
            return Convert.ChangeType(value, type, Invariant);
        }

        static string Execute(string action, byte[] data, List<Binding> bindings)
        {
            if (action != "setNamedVariable") throw new InvalidOperationException("Choose an available managed variable");
            var cursor = new Reader(data);
            var payload = cursor.Read(0) as Dictionary<string, object>;
            if (payload == null || cursor.Position != data.Length) throw new InvalidOperationException("Refresh the variable and retry");
            var parameters = payload["params"] as Dictionary<string, object>;
            if (parameters == null || (string)parameters["gameSessionId"] != Session || (string)parameters["scope"] != "store") throw new InvalidOperationException("Refresh variables for the current game session");
            string name = (string)parameters["name"], store = (string)parameters["store"];
            Binding binding = bindings.Find(delegate(Binding item) { return item.Name == name && item.Store == store; });
            if (binding == null) throw new InvalidOperationException("Refresh the list and choose an existing variable");
            object before = binding.Get(), after = Converted(payload["value"], before);
            System.IO.Directory.CreateDirectory(BackupPath);
            string backup = "{\"session\":" + Json(Session) + ",\"engine\":" + Json(Engine) + ",\"name\":" + Json(name) + ",\"label\":" + Json(binding.Label) + ",\"before\":" + Json(before) + ",\"after\":" + Json(after) + "}";
            File.WriteAllText(Path.Combine(BackupPath, DateTime.UtcNow.Ticks.ToString(Invariant) + "-" + Guid.NewGuid().ToString("N") + ".json"), backup, Utf8);
            binding.Set(after);
            if (!Object.Equals(binding.Get(), after)) throw new InvalidOperationException("The game changed this value; refresh and retry");
            return "{\"ok\":true}";
        }

        static void Poll()
        {
            var bindings = Catalog();
            var results = new List<string>();
            string file = Path.Combine(DirectoryPath, "commands.txt");
            if (File.Exists(file))
            {
                string[] lines = File.ReadAllLines(file, Encoding.ASCII);
                if (lines.Length == 0 || lines[0] != Token) return;
                for (int i = 1; i < lines.Length && i <= 100; i++)
                {
                    string[] parts = lines[i].Split('\t');
                    if (parts.Length != 6) continue;
                    string id = parts[0], result;
                    if (!Completed.TryGetValue(id, out result))
                    {
                        try
                        {
                            if (parts[4] != "tagged" || parts[5].Length > 2097152 || parts[5].Length % 2 != 0) throw new InvalidOperationException("Refresh the variable and retry");
                            byte[] data = new byte[parts[5].Length / 2];
                            for (int n = 0; n < data.Length; n++) data[n] = Byte.Parse(parts[5].Substring(n * 2, 2), NumberStyles.HexNumber, Invariant);
                            result = Execute(parts[1], data, bindings);
                        }
                        catch (Exception error) { result = "{\"error\":" + Json(error.Message) + "}"; }
                        Completed[id] = result; CompletedOrder.Enqueue(id);
                        if (CompletedOrder.Count > 100) Completed.Remove(CompletedOrder.Dequeue());
                    }
                    results.Add("{\"id\":" + Json(id) + "," + result.Substring(1));
                }
            }
            var rows = new List<string>();
            foreach (Binding binding in bindings)
            {
                object value = binding.Get();
                bool integer = value is byte || value is sbyte || value is short || value is ushort || value is int || value is uint || value is long || value is ulong;
                rows.Add("{\"scope\":\"store\",\"persistence\":\"unknown\",\"store\":" + Json(binding.Store) + ",\"name\":" + Json(binding.Name) + ",\"label\":" + Json(binding.Label) + ",\"type\":" + Json(binding.Type) + ",\"integer\":" + (integer ? "true" : "false") + ",\"value\":" + Json(value) + "}");
            }
            bool truncated = CatalogLimits.Count > 0;
            string state = "{\"token\":" + Json(Token) + ",\"state\":{\"ready\":true,\"engine\":" + Json(Engine) + ",\"mode\":\"live\",\"actions\":[\"setNamedVariable\"],\"gameSessionId\":" + Json(Session) + ",\"catalogComplete\":" + (truncated ? "false" : "true") + ",\"truncated\":" + (truncated ? "true" : "false") + ",\"limitReason\":" + Json(String.Join(",", new List<string>(CatalogLimits).ToArray())) + ",\"namedVariables\":[" + String.Join(",", rows.ToArray()) + "]},\"results\":[" + String.Join(",", results.ToArray()) + "]}";
            string target = Path.Combine(DirectoryPath, "state.json"), temporary = Path.Combine(DirectoryPath, "state-managed.tmp");
            File.WriteAllText(temporary, state, Utf8);
            if (File.Exists(target)) File.Delete(target);
            File.Move(temporary, target);
        }

        static string Json(object value)
        {
            if (value == null) return "null";
            if (value is bool) return (bool)value ? "true" : "false";
            if (!(value is string)) return Convert.ToString(value, Invariant);
            var builder = new StringBuilder("\"");
            foreach (char item in (string)value)
            {
                if (item == '\\' || item == '"') builder.Append('\\').Append(item);
                else if (item < 32 || Char.IsSurrogate(item)) builder.Append("\\u").Append(((int)item).ToString("x4", Invariant));
                else builder.Append(item);
            }
            return builder.Append('"').ToString();
        }

        class Reader
        {
            readonly byte[] Data;
            public int Position;
            public Reader(byte[] data) { Data = data; }
            int Count(char separator)
            {
                int start = Position;
                while (Position < Data.Length && Data[Position] != separator) Position++;
                int count = Int32.Parse(Encoding.ASCII.GetString(Data, start, Position - start), Invariant);
                if (Position >= Data.Length || count < 0 || count > 1048576) throw new InvalidOperationException("Invalid parameter length");
                Position++; return count;
            }
            public object Read(int depth)
            {
                if (depth > 10 || Position >= Data.Length) throw new InvalidOperationException("Invalid auxiliary parameters");
                char tag = (char)Data[Position++];
                if (tag == 'n') return null;
                if (tag == 't' || tag == 'f') return tag == 't';
                if (tag == 'd')
                {
                    int start = Position; while (Position < Data.Length && Data[Position] != ';') Position++;
                    if (Position >= Data.Length) throw new InvalidOperationException("Incomplete numeric parameter");
                    string number = Encoding.ASCII.GetString(Data, start, Position++ - start);
                    return Double.Parse(number, Invariant);
                }
                if (tag == 's') { int length = Count(':'); if (Position + length > Data.Length) throw new InvalidOperationException("Incomplete string parameter"); string value = Encoding.UTF8.GetString(Data, Position, length); Position += length; return value; }
                if (tag == 'o')
                {
                    int length = Count(':'); var result = new Dictionary<string, object>();
                    for (int i = 0; i < length; i++) { string key = Read(depth + 1) as string; if (key == null || result.ContainsKey(key)) throw new InvalidOperationException("Invalid parameter key"); result.Add(key, Read(depth + 1)); }
                    return result;
                }
                throw new InvalidOperationException("Select scalar managed-variable parameters");
            }
        }
    }
}
