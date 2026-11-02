using System;
using System.Linq;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Mono.Cecil;
using Mono.Cecil.Cil;

// Static metadata only. No target assembly is loaded into the CLR.
class UnityTextAsset
{
    static IEnumerable<TypeDefinition> Types(IEnumerable<TypeDefinition> roots)
    {
        foreach (var type in roots) { yield return type; foreach (var child in Types(type.NestedTypes)) yield return child; }
    }
    static object Operand(object value)
    {
        if (value is Instruction) return ((Instruction)value).Offset;
        if (value is Instruction[]) return ((Instruction[])value).Select(i => i.Offset).ToArray();
        if (value is VariableDefinition) return ((VariableDefinition)value).Index;
        if (value is ParameterDefinition) return ((ParameterDefinition)value).Index;
        if (value is MemberReference) return ((MemberReference)value).FullName;
        return value;
    }
    static int Main(string[] args)
    {
        try {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            if (args.Length != 1) throw new ArgumentException("Expected one source managed assembly");
            byte[] bytes = File.ReadAllBytes(args[0]);
            string digest; using (var sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            using (var module = ModuleDefinition.ReadModule(new MemoryStream(bytes))) {
                var methods = Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody).ToArray();
                // Candidate readers plus their callers and resource loaders. Avoid exporting unrelated story literals.
                var selected = new HashSet<string>(methods.Where(m => m.Body.Instructions.Any(i => i.Operand is MethodReference && ((MethodReference)i.Operand).DeclaringType.FullName == "System.String" && ((MethodReference)i.Operand).Name == "Split")).Select(m => m.FullName));
                foreach (var method in methods.Where(m => m.Body.Instructions.Any(i => i.Operand is MethodReference && selected.Contains(((MethodReference)i.Operand).FullName))).ToArray()) selected.Add(method.FullName);
                foreach (var method in methods.Where(m => m.Body.Instructions.Any(i => i.Operand is MethodReference && ((MethodReference)i.Operand).DeclaringType.FullName == "UnityEngine.Resources" && ((MethodReference)i.Operand).Name == "Load"))) selected.Add(method.FullName);
                var builders = new HashSet<string>(methods.Where(m => selected.Contains(m.FullName)).SelectMany(m => m.Body.Instructions)
                    .Where(i => i.Operand is MethodReference && ((MethodReference)i.Operand).Name == "Append")
                    .Select(i => ((MethodReference)i.Operand).DeclaringType.FullName));
                var json = new JavaScriptSerializer { MaxJsonLength = 64000000, RecursionLimit = 128 };
                Console.WriteLine(json.Serialize(new { schema = "pinhao-unity-textasset-il-v1", assemblySha256 = digest,
                    methods = methods.Where(m => selected.Contains(m.FullName)).Select(m => new { method = m.FullName, token = m.MetadataToken.ToInt32(),
                        hasExceptionHandlers = m.Body.HasExceptionHandlers,
                        instructions = m.Body.Instructions.Select(i => new { offset = i.Offset, op = i.OpCode.Name, operand = Operand(i.Operand) }).ToArray() }).ToArray(),
                    builderMethods = methods.Where(m => builders.Contains(m.DeclaringType.FullName) && new[] { ".ctor", "Set", "Append", "ToString" }.Contains(m.Name))
                        .Select(m => new { type = m.DeclaringType.FullName, name = m.Name, signature = m.FullName,
                            hasExceptionHandlers = m.Body.HasExceptionHandlers,
                            instructions = m.Body.Instructions.Select(i => new { offset = i.Offset, op = i.OpCode.Name, operand = Operand(i.Operand) }).ToArray() }).ToArray() }));
            }
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
