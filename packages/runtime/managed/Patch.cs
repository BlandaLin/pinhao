using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Mono.Cecil;
using Mono.Cecil.Cil;

class Patch
{
    static IEnumerable<TypeDefinition> Types(IEnumerable<TypeDefinition> types)
    {
        foreach (var type in types) { yield return type; foreach (var child in Types(type.NestedTypes)) yield return child; }
    }
    static bool UnityType(TypeDefinition type, ModuleDefinition module)
    {
        var seen = new HashSet<string>();
        while (type != null && type.BaseType != null && seen.Add(type.FullName))
        {
            if (type.BaseType.FullName == "UnityEngine.MonoBehaviour") return true;
            var name = type.BaseType.FullName;
            type = Types(module.Types).FirstOrDefault(item => item.FullName == name);
        }
        return false;
    }
    static string J(string value) { return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t") + "\""; }
    static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            var resolver = new DefaultAssemblyResolver();
            resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(args[1])));
            using (var module = ModuleDefinition.ReadModule(args[1], new ReaderParameters { AssemblyResolver = resolver, ReadingMode = ReadingMode.Immediate }))
            {
                string engine = args[2];
                var hooks = new List<MethodDefinition>();
                foreach (var type in Types(module.Types))
                {
                    bool accepted = engine == "Unity" ? UnityType(type, module) :
                        type.FullName.StartsWith("Yukar.Engine.") && (type.Name == "GameMain" || type.Name == "MapScene" || type.Name == "BattleScene");
                    if (!accepted || type.HasGenericParameters) continue;
                    foreach (string name in new [] { "Update", "update", "LateUpdate", "FixedUpdate", "OnGUI" })
                    {
                        var method = type.Methods.FirstOrDefault(item => item.Name == name && item.HasBody && !item.IsStatic && !item.HasGenericParameters);
                        if (method != null) { hooks.Add(method); break; }
                    }
                }
                bool signed = module.Assembly != null && module.Assembly.Name.HasPublicKey;
                string framework = module.AssemblyReferences.Any(item => item.Name == "mscorlib" && item.Version.Major <= 2) ? "net20" : "net40";
                if (args[0] == "probe")
                {
                    bool injected = hooks.Count > 0 && hooks.All(method => method.Body.Instructions.Any(instruction => instruction.OpCode == OpCodes.Call && instruction.Operand is MethodReference && ((MethodReference)instruction.Operand).DeclaringType.FullName == "Pinhao.ManagedAssist.Bridge"));
                    var fields = hooks.Select(method => method.DeclaringType).Distinct().SelectMany(type => type.Fields).Select(field => J(field.FullName));
                    Console.WriteLine("{\"framework\":" + J(framework) + ",\"signed\":" + (signed ? "true" : "false") + ",\"injected\":" + (injected ? "true" : "false") + ",\"hooks\":[" + string.Join(",", hooks.Select(method => J(method.FullName))) + "],\"fields\":[" + string.Join(",", fields) + "]}");
                    return 0;
                }
                if (signed || hooks.Count == 0) throw new InvalidOperationException("Select an unsigned managed game with a frame update method");
                using (var helper = ModuleDefinition.ReadModule(args[3]))
                {
                    var tick = module.ImportReference(helper.Types.First(type => type.FullName == "Pinhao.ManagedAssist.Bridge").Methods.First(method => method.Name == "Tick"));
                    foreach (var method in hooks)
                    {
                        if (method.Body.Instructions.Any(instruction => instruction.OpCode == OpCodes.Call && instruction.Operand is MethodReference && ((MethodReference)instruction.Operand).DeclaringType.FullName == "Pinhao.ManagedAssist.Bridge")) continue;
                        var il = method.Body.GetILProcessor();
                        var first = method.Body.Instructions[0];
                        il.InsertBefore(first, il.Create(OpCodes.Ldarg_0));
                        il.InsertBefore(first, il.Create(OpCodes.Ldstr, engine));
                        il.InsertBefore(first, il.Create(OpCodes.Call, tick));
                    }
                    module.Write(args[4]);
                }
                Console.WriteLine("{\"hooks\":" + hooks.Count + ",\"framework\":" + J(framework) + "}");
                return 0;
            }
        }
        catch (Exception error) { Console.Error.WriteLine(error.GetType().Name + ": " + error.Message); return 1; }
    }
}
