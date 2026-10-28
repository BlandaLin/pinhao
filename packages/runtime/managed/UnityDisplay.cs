using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Mono.Cecil;
using Mono.Cecil.Cil;

// A bounded consumer proof, not a whole-program taint analysis. Unsupported uses remain pending.
class UnityDisplay
{
    const string GeneratedType = "Pinhao.GeneratedDisplay";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 16777216 };
    class Proof { public bool Display, Unsafe, Returned; public List<string> Calls = new List<string>(); public HashSet<string> Receivers = new HashSet<string>(); }
    class Site { public string Id, Kind = "field-load", ArrayField; public FieldReference Field; public MethodDefinition Method; public Instruction Load, Store; public Proof Proof; public object[] ReadUses; }
    class CodeElement { public int Index; public string Source, Reason; public int[] Offsets; public bool Supported; }
    class CodeGroup { public string Id, ArrayField; public int AllocationOffset; public MethodDefinition Method; public List<CodeElement> Elements = new List<CodeElement>(); }
    static string Hash(byte[] value) { using (var sha = SHA256.Create()) return String.Concat(sha.ComputeHash(value).Select(b => b.ToString("x2"))); }
    static string Hash(string value) { return Hash(Encoding.UTF8.GetBytes(value)); }
    static IEnumerable<TypeDefinition> Types(IEnumerable<TypeDefinition> types)
    { foreach (var type in types) { yield return type; foreach (var child in Types(type.NestedTypes)) yield return child; } }
    static bool TextControl(TypeReference type)
    { return new [] { "UnityEngine.UI.Text", "UnityEngine.TextMesh", "TMPro.TMP_Text", "TMPro.TextMeshPro", "TMPro.TextMeshProUGUI" }.Contains(type.FullName); }
    static bool Sink(MethodReference method)
    { return TextControl(method.DeclaringType) && method.Name == "set_text" && method.HasThis && method.ReturnType.MetadataType == MetadataType.Void && method.Parameters.Count == 1 && method.Parameters[0].ParameterType.FullName == "System.String"; }
    static bool Readback(TypeDefinition type)
    { return type.Methods.Where(m => m.HasBody).SelectMany(m => m.Body.Instructions).Any(i => i.Operand is MethodReference &&
        TextControl(((MethodReference)i.Operand).DeclaringType) && ((MethodReference)i.Operand).Name == "get_text"); }
    static int Argument(Instruction instruction)
    {
        if (instruction.OpCode == OpCodes.Ldarg_0) return 0;
        if (instruction.OpCode == OpCodes.Ldarg_1) return 1;
        if (instruction.OpCode == OpCodes.Ldarg_2) return 2;
        if (instruction.OpCode == OpCodes.Ldarg_3) return 3;
        if (instruction.OpCode == OpCodes.Ldarg || instruction.OpCode == OpCodes.Ldarg_S)
        { var parameter = (ParameterDefinition)instruction.Operand; return parameter.Index + (parameter.Method.HasThis ? 1 : 0); }
        return -1;
    }
    static int FixedCount(StackBehaviour behavior)
    { var text = behavior.ToString(); return text == "Pop0" || text == "Push0" ? 0 : text == "Varpop" || text == "Varpush" ? -1 : text.Split('_').Length; }
    static Proof Parameter(MethodDefinition method, int parameter, int nesting)
    {
        var proof = new Proof();
        if (method == null || !method.HasBody || nesting > 2 || Readback(method.DeclaringType)) { proof.Unsafe = true; return proof; }
        var loads = method.Body.Instructions.Where(i => Argument(i) == parameter + (method.HasThis ? 1 : 0)).ToList();
        if (loads.Count == 0) { proof.Unsafe = true; return proof; }
        foreach (var load in loads) Merge(proof, Trace(method, load.Next, 0, nesting, false, method.ReturnType.FullName == "System.String"));
        return proof;
    }
    static void Merge(Proof target, Proof value)
    { target.Display |= value.Display; target.Unsafe |= value.Unsafe; target.Returned |= value.Returned; target.Calls.AddRange(value.Calls); target.Receivers.UnionWith(value.Receivers); }
    static string Receiver(Instruction call, int depth)
    {
        for (var instruction = call.Previous; instruction != null; instruction = instruction.Previous)
        {
            if (instruction.OpCode.FlowControl == FlowControl.Branch || instruction.OpCode.FlowControl == FlowControl.Cond_Branch) return null;
            if (instruction.OpCode == OpCodes.Dup) { if (depth < 2) depth = 0; else depth--; continue; }
            var method = instruction.Operand as MethodReference;
            bool invoking = instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt || instruction.OpCode == OpCodes.Newobj;
            int pop = invoking && method != null ? method.Parameters.Count + (method.HasThis && instruction.OpCode != OpCodes.Newobj ? 1 : 0) : FixedCount(instruction.OpCode.StackBehaviourPop);
            int push = invoking && method != null ? (instruction.OpCode == OpCodes.Newobj || method.ReturnType.MetadataType != MetadataType.Void ? 1 : 0) : FixedCount(instruction.OpCode.StackBehaviourPush);
            if (pop < 0 || push < 0) return null;
            if (depth < push) { var field = instruction.Operand as FieldReference; return instruction.OpCode == OpCodes.Ldfld && field != null ? field.FullName : null; }
            depth += pop - push;
        }
        return null;
    }
    static Proof Trace(MethodDefinition method, Instruction first, int firstDepth, int nesting, bool presentation = false, bool allowReturn = false, HashSet<string> fields = null, bool character = false)
    {
        var result = new Proof();
        var queue = new Queue<Tuple<Instruction, int>>(); queue.Enqueue(Tuple.Create(first, firstDepth));
        var visited = new HashSet<string>();
        while (queue.Count > 0)
        {
            var state = queue.Dequeue(); var instruction = state.Item1; int depth = state.Item2;
            if (instruction == null || visited.Count > 512) { result.Unsafe = true; continue; }
            if (!visited.Add(instruction.Offset + ":" + depth)) continue;
            if (allowReturn && instruction.OpCode == OpCodes.Ret && depth == 0) { result.Returned = true; continue; }
            int? storedLocal = Local(instruction, true);
            if (depth == 0 && storedLocal.HasValue && method.Body.Variables[storedLocal.Value].VariableType.FullName == "System.String")
            {
                foreach (var load in method.Body.Instructions.Where(i => Local(i, false) == storedLocal)) queue.Enqueue(Tuple.Create(load.Next, 0));
                continue;
            }
            var storedField = instruction.Operand as FieldReference;
            if (depth == 0 && instruction.OpCode == OpCodes.Stfld && storedField != null && storedField.FieldType.FullName == "System.String")
            { Merge(result, FieldConsumers(method.Module, storedField, nesting, fields ?? new HashSet<string>())); continue; }
            var call = instruction.Operand as MethodReference;
            bool invoking = instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt || instruction.OpCode == OpCodes.Newobj;
            int pop = invoking && call != null ? call.Parameters.Count + (call.HasThis && instruction.OpCode != OpCodes.Newobj ? 1 : 0) : FixedCount(instruction.OpCode.StackBehaviourPop);
            int push = invoking && call != null ? (instruction.OpCode == OpCodes.Newobj || call.ReturnType.MetadataType != MetadataType.Void ? 1 : 0) : FixedCount(instruction.OpCode.StackBehaviourPush);
            if (pop < 0 || push < 0 || instruction.OpCode == OpCodes.Dup || instruction.OpCode == OpCodes.Leave || instruction.OpCode == OpCodes.Leave_S)
            { result.Unsafe = true; continue; }
            if (depth < pop)
            {
                if (invoking && call != null)
                {
                    result.Calls.Add(method.FullName + "@" + instruction.Offset.ToString("x4") + " -> " + call.FullName);
                    if (Sink(call) && depth == 0) { result.Display = true; var receiver = Receiver(instruction, 1); if (receiver != null) result.Receivers.Add(receiver); continue; }
                    if (call.DeclaringType.FullName == "System.String" && call.Name == "Concat" && call.ReturnType.FullName == "System.String" && call.Parameters.All(p => p.ParameterType.FullName == "System.String"))
                    { queue.Enqueue(Tuple.Create(instruction.Next, 0)); continue; }
                    if (call.DeclaringType.FullName == "System.String" && call.Name == "Replace" && call.HasThis && depth == 2 && call.Parameters.Count == 2 && call.Parameters.All(p => p.ParameterType.FullName == "System.String"))
                    { queue.Enqueue(Tuple.Create(instruction.Next, 0)); continue; }
                    if (presentation && Length(instruction) && depth == 0 && PresentationLength(method, instruction)) continue;
                    if (presentation && call.DeclaringType.FullName == "System.String" && call.Name == "Substring" && call.Parameters.Count == 2 &&
                        call.Parameters.All(p => p.ParameterType.FullName == "System.Int32") && depth == 2)
                    { queue.Enqueue(Tuple.Create(instruction.Next, 0)); continue; }
                    if (presentation && character && call.DeclaringType.FullName == "System.String" && call.Name == "op_Equality" && depth == 1 && PunctuationLiteral(instruction.Previous)) continue;
                    if (presentation && call.DeclaringType.FullName == "System.String" && call.Name == "Contains" && depth == 0 && OneCharacter(instruction.Previous) && PunctuationReceiver(method.Module, instruction)) continue;
                    if (presentation && depth == 0 && call.FullName == "System.Void UnityEngine.Debug::Log(System.Object)") continue;
                    if (nesting < 2 && depth < call.Parameters.Count)
                    {
                        MethodDefinition target = null; try { target = call.Resolve(); } catch { }
                        bool fixedDispatch = instruction.OpCode != OpCodes.Callvirt || target != null && (!target.IsVirtual || target.IsFinal || target.DeclaringType.IsSealed);
                        if (target != null && fixedDispatch && target.Module == method.Module && (target.ReturnType.MetadataType == MetadataType.Void || target.ReturnType.FullName == "System.String"))
                        {
                            var proof = Parameter(target, call.Parameters.Count - 1 - depth, nesting + 1);
                            bool returned = proof.Returned; proof.Returned = false; Merge(result, proof);
                            if (returned && !proof.Unsafe) queue.Enqueue(Tuple.Create(instruction.Next, 0));
                            continue;
                        }
                    }
                }
                result.Unsafe = true; continue;
            }
            int nextDepth = depth - pop + push;
            var targetInstruction = instruction.Operand as Instruction;
            if (targetInstruction != null) queue.Enqueue(Tuple.Create(targetInstruction, nextDepth));
            var targets = instruction.Operand as Instruction[];
            if (targets != null) foreach (var target in targets) queue.Enqueue(Tuple.Create(target, nextDepth));
            if (instruction.OpCode.FlowControl != FlowControl.Branch && instruction.OpCode.FlowControl != FlowControl.Return && instruction.OpCode.FlowControl != FlowControl.Throw)
                queue.Enqueue(Tuple.Create(instruction.Next, nextDepth));
            else if (targetInstruction == null && targets == null) result.Unsafe = true;
        }
        return result;
    }
    static bool OneCharacter(Instruction instruction)
    { var call = instruction == null ? null : instruction.Operand as MethodReference; return call != null && call.DeclaringType.FullName == "System.String" && call.Name == "Substring" && call.Parameters.Count == 2 && Integer(instruction.Previous) == 1; }
    static bool PunctuationLiteral(Instruction instruction)
    { return instruction != null && instruction.OpCode == OpCodes.Ldstr && ((string)instruction.Operand).Length > 0 && ((string)instruction.Operand).All(c => Char.IsPunctuation(c) || Char.IsWhiteSpace(c)); }
    static bool PunctuationReceiver(ModuleDefinition module, Instruction call)
    {
        string receiver = Receiver(call, 1);
        if (receiver == null) return false;
        var writes = Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody).SelectMany(m => m.Body.Instructions)
            .Where(i => i.OpCode == OpCodes.Stfld && i.Operand is FieldReference && ((FieldReference)i.Operand).FullName == receiver).ToArray();
        return writes.Length > 0 && writes.All(i => PunctuationLiteral(i.Previous));
    }
    static Proof FieldConsumers(ModuleDefinition module, FieldReference field, int nesting, HashSet<string> fields)
    {
        var proof = new Proof();
        if (fields.Count > 32) { proof.Unsafe = true; return proof; }
        if (!fields.Add(field.FullName)) return proof;
        var methods = Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody).ToArray();
        var writes = methods.SelectMany(m => m.Body.Instructions).Where(i => i.OpCode == OpCodes.Stfld && i.Operand is FieldReference && ((FieldReference)i.Operand).FullName == field.FullName).ToArray();
        bool character = writes.Length > 0 && writes.All(i => OneCharacter(i.Previous));
        foreach (var method in methods) foreach (var load in method.Body.Instructions.Where(i => i.Operand is FieldReference && ((FieldReference)i.Operand).FullName == field.FullName))
        {
            if (load.OpCode == OpCodes.Ldfld) Merge(proof, Trace(method, load.Next, 0, nesting, true, false, fields, character));
            else if (load.OpCode != OpCodes.Stfld) proof.Unsafe = true;
        }
        return proof;
    }
    static bool Length(Instruction instruction)
    { var call = instruction == null ? null : instruction.Operand as MethodReference; return call != null && call.DeclaringType.FullName == "System.String" && call.Name == "get_Length" && call.Parameters.Count == 0; }
    static bool PresentationLength(MethodDefinition method, Instruction length)
    {
        string field = Receiver(length, 0);
        if (field == null) return false;
        bool sliced = method.Body.Instructions.Any(i => i.Operand is MethodReference &&
            ((MethodReference)i.Operand).DeclaringType.FullName == "System.String" && ((MethodReference)i.Operand).Name == "Substring" &&
            Receiver(i, ((MethodReference)i.Operand).Parameters.Count) == field);
        int depth = 0, steps = 0;
        for (var instruction = length.Next; instruction != null && steps++ < 64; instruction = instruction.Next)
        {
            var call = instruction.Operand as MethodReference;
            bool invoking = instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt || instruction.OpCode == OpCodes.Newobj;
            int pop = invoking && call != null ? call.Parameters.Count + (call.HasThis && instruction.OpCode != OpCodes.Newobj ? 1 : 0) : FixedCount(instruction.OpCode.StackBehaviourPop);
            int push = invoking && call != null ? (instruction.OpCode == OpCodes.Newobj || call.ReturnType.MetadataType != MetadataType.Void ? 1 : 0) : FixedCount(instruction.OpCode.StackBehaviourPush);
            if (instruction.OpCode == OpCodes.Ret || pop < 0 || push < 0 || instruction.OpCode == OpCodes.Dup) return false;
            if (depth < pop)
            {
                if (invoking) return call != null && call.DeclaringType.FullName == "System.String" && call.Name == "Substring" &&
                    depth < call.Parameters.Count && Receiver(instruction, call.Parameters.Count) == field;
                if (instruction.OpCode.FlowControl == FlowControl.Cond_Branch) return sliced && PresentationBranch(method, instruction);
                if (new [] { OpCodes.Add, OpCodes.Sub, OpCodes.Mul, OpCodes.Div, OpCodes.Rem }.Contains(instruction.OpCode)) { depth = 0; continue; }
                return false;
            }
            depth += push - pop;
            if (instruction.OpCode.FlowControl != FlowControl.Next && instruction.OpCode.FlowControl != FlowControl.Call) return false;
        }
        return false;
    }
    static bool PresentationBranch(MethodDefinition method, Instruction branch)
    {
        var end = branch.Operand as Instruction;
        if (end == null || end.Offset <= branch.Offset) return false;
        bool iterator = method.Name == "MoveNext" && method.DeclaringType.Interfaces.Any(i => i.InterfaceType.FullName == "System.Collections.IEnumerator") &&
            method.DeclaringType.CustomAttributes.Any(a => a.AttributeType.FullName == "System.Runtime.CompilerServices.CompilerGeneratedAttribute");
        for (var instruction = branch.Next; instruction != end; instruction = instruction.Next)
        {
            if (instruction == null || instruction.OpCode == OpCodes.Ret || instruction.OpCode == OpCodes.Throw ||
                instruction.OpCode == OpCodes.Stsfld || instruction.OpCode.Name.StartsWith("stelem") ||
                instruction.OpCode.Name.StartsWith("stind") || instruction.OpCode == OpCodes.Stobj || instruction.OpCode == OpCodes.Cpobj ||
                instruction.OpCode == OpCodes.Initobj || Local(instruction, true).HasValue) return false;
            if (instruction.OpCode == OpCodes.Stfld)
            {
                var field = instruction.Operand as FieldReference;
                if (!iterator || field == null || field.DeclaringType.FullName != method.DeclaringType.FullName ||
                    !(field.Name.StartsWith("<") || field.Name.StartsWith("$"))) return false;
            }
            var call = instruction.Operand as MethodReference;
            if (call != null && instruction.OpCode.FlowControl == FlowControl.Call && !Sink(call) &&
                !(call.DeclaringType.FullName == "System.String" && new [] { "Concat", "Substring", "get_Length", "Contains", "op_Equality" }.Contains(call.Name))) return false;
        }
        return true;
    }
    static bool EmptyResetRead(Instruction load, string field)
    {
        if (load.Previous == null || load.Previous.OpCode != OpCodes.Ldarg_0) return false;
        for (var prior = load.Previous.Previous; prior != null; prior = prior.Previous)
        {
            if (prior.OpCode.FlowControl != FlowControl.Next) return false;
            var target = prior.Operand as FieldReference;
            if (prior.OpCode != OpCodes.Stfld || target == null || target.FullName != field) continue;
            var value = prior.Previous; var empty = value == null ? null : value.Operand as FieldReference;
            return value != null && value.Previous != null && value.Previous.OpCode == OpCodes.Ldarg_0 &&
                (value.OpCode == OpCodes.Ldstr && (string)value.Operand == "" || value.OpCode == OpCodes.Ldsfld && empty != null && empty.FullName == "System.String System.String::Empty");
        }
        return false;
    }
    static bool Targeted(MethodDefinition method, Instruction instruction)
    { return method.Body.Instructions.Any(i => i.Operand == instruction || i.Operand is Instruction[] && ((Instruction[])i.Operand).Contains(instruction)) ||
        method.Body.ExceptionHandlers.Any(h => h.TryStart == instruction || h.TryEnd == instruction || h.HandlerStart == instruction || h.HandlerEnd == instruction || h.FilterStart == instruction); }
    static IEnumerable<Site> PresentationSites(ModuleDefinition module, string assemblyHash)
    {
        var methods = Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody).ToArray();
        var arrays = new HashSet<string>(Types(module.Types).SelectMany(t => t.Fields).Where(f => f.FieldType.FullName == "System.String[]").Select(f => f.FullName));
        foreach (var method in methods) foreach (var store in method.Body.Instructions)
        {
            var field = store.Operand as FieldReference;
            if (store.OpCode != OpCodes.Stfld || field == null || field.FieldType.FullName != "System.String" || store.Previous == null ||
                store.Previous.OpCode != OpCodes.Ldelem_Ref || Targeted(method, store)) continue;
            string array = Receiver(store.Previous, 1);
            if (array == null || !arrays.Contains(array)) continue;
            var proof = new Proof(); var reads = new List<object>(); bool length = false, substring = false;
            foreach (var owner in methods) foreach (var use in owner.Body.Instructions.Where(i => i.Operand is FieldReference && ((FieldReference)i.Operand).FullName == field.FullName))
            {
                string role = "write"; var part = new Proof();
                if (use.OpCode == OpCodes.Ldfld)
                {
                    if (Length(use.Next) && PresentationLength(owner, use.Next)) { role = "length-metadata"; length = true; part.Calls.Add(owner.FullName + "@" + use.Next.Offset.ToString("x4") + " -> " + ((MethodReference)use.Next.Operand).FullName); }
                    else if (EmptyResetRead(use, field.FullName)) role = "known-empty-reset-read";
                    else { role = "string-consumer"; part = Trace(owner, use.Next, 0, 0, true); substring |= part.Calls.Any(c => c.Contains("System.String::Substring(")); }
                }
                else if (use.OpCode != OpCodes.Stfld) { role = "unsupported-address-or-use"; part.Unsafe = true; }
                Merge(proof, part);
                reads.Add(new { method = owner.FullName, offset = use.Offset, operation = use.OpCode.Name, role = role, display = part.Display, unresolvedOrBusinessUse = part.Unsafe, calls = part.Calls.Distinct().ToArray() });
            }
            if (length && !substring || Readback(method.DeclaringType)) proof.Unsafe = true;
            yield return new Site { Id = "display-site-v1:" + Hash(assemblyHash + "\0presentation-store\0" + method.FullName + "\0" + store.Offset + "\0" + field.FullName),
                Kind = "presentation-store", ArrayField = array, Field = field, Method = method, Load = store.Previous, Store = store, Proof = proof, ReadUses = reads.ToArray() };
        }
    }
    static IEnumerable<Site> ArrayElementSites(ModuleDefinition module, string assemblyHash)
    {
        var arrays = Types(module.Types).SelectMany(t => t.Fields).Where(f => f.FieldType.FullName == "System.String[]").ToDictionary(f => f.FullName);
        foreach (var method in Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody)) foreach (var load in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Ldelem_Ref))
        {
            string array = Receiver(load, 1); FieldDefinition field;
            if (array == null || !arrays.TryGetValue(array, out field)) continue;
            var proof = Trace(method, load.Next, 0, 0);
            if (Readback(method.DeclaringType)) proof.Unsafe = true;
            yield return new Site { Id = "display-site-v1:" + Hash(assemblyHash + "\0array-element\0" + method.FullName + "\0" + load.Offset + "\0" + array),
                Kind = "array-element", ArrayField = array, Field = field, Method = method, Load = load, Proof = proof };
        }
    }
    static Instruction StackValue(Instruction call, int depth)
    {
        int steps = 0;
        for (var instruction = call.Previous; instruction != null && steps++ < 64; instruction = instruction.Previous)
        {
            if (instruction.OpCode.FlowControl == FlowControl.Branch || instruction.OpCode.FlowControl == FlowControl.Cond_Branch || instruction.OpCode == OpCodes.Dup) return null;
            var target = instruction.Operand as MethodReference;
            bool invoking = instruction.OpCode == OpCodes.Call || instruction.OpCode == OpCodes.Callvirt || instruction.OpCode == OpCodes.Newobj;
            int pop = invoking && target != null ? target.Parameters.Count + (target.HasThis && instruction.OpCode != OpCodes.Newobj ? 1 : 0) : FixedCount(instruction.OpCode.StackBehaviourPop);
            int push = invoking && target != null ? (instruction.OpCode == OpCodes.Newobj || target.ReturnType.MetadataType != MetadataType.Void ? 1 : 0) : FixedCount(instruction.OpCode.StackBehaviourPush);
            if (pop < 0 || push < 0) return null;
            if (depth < push) return instruction;
            depth += pop - push;
        }
        return null;
    }
    static MethodReference Substring(ModuleDefinition module)
    {
        var method = new MethodReference("Substring", module.TypeSystem.String, module.TypeSystem.String) { HasThis = true };
        method.Parameters.Add(new ParameterDefinition(module.TypeSystem.Int32)); method.Parameters.Add(new ParameterDefinition(module.TypeSystem.Int32));
        return method;
    }
    static IEnumerable<Site> PresentationSliceSites(ModuleDefinition module, string assemblyHash, Site[] stores)
    {
        var linked = stores.GroupBy(s => s.Field.FullName).ToDictionary(g => g.Key, g => g.ToArray());
        foreach (var method in Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody))
            foreach (var instruction in method.Body.Instructions)
            {
                var call = instruction.Operand as MethodReference;
                if (instruction.OpCode != OpCodes.Callvirt || call == null || call.FullName != Substring(module).FullName ||
                    Integer(StackValue(instruction, 1)) != 0 || Targeted(method, instruction)) continue;
                string field = Receiver(instruction, 2); Site[] origins;
                if (field == null || !linked.TryGetValue(field, out origins) || origins.Any(s => s.Proof.Display && !s.Proof.Unsafe) ||
                    origins.Select(s => s.ArrayField).Distinct().Count() != 1) continue;
                var proof = Trace(method, instruction.Next, 0, 0);
                if (Readback(method.DeclaringType)) proof.Unsafe = true;
                proof.Calls.Insert(0, method.FullName + "@" + instruction.Offset.ToString("x4") + " -> " + call.FullName);
                yield return new Site { Id = "display-site-v1:" + Hash(assemblyHash + "\0presentation-slice\0" + method.FullName + "\0" + instruction.Offset + "\0" + field),
                    Kind = "presentation-slice", ArrayField = origins[0].ArrayField, Field = origins[0].Field, Method = method, Load = instruction, Proof = proof };
            }
    }
    static List<Site> Sites(ModuleDefinition module, string assemblyHash)
    {
        var result = new List<Site>();
        var aliases = new Dictionary<string, HashSet<string>>();
        foreach (var method in Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody))
            foreach (var instruction in method.Body.Instructions)
            {
                var field = instruction.Operand as FieldReference;
                if (instruction.OpCode != OpCodes.Stfld || field == null || !TextControl(field.FieldType) || instruction.Previous == null) continue;
                var value = instruction.Previous.Operand as FieldReference;
                int argument = Argument(instruction.Previous);
                string source = value != null && TextControl(value.FieldType) ? value.FullName
                    : argument >= 0 ? "argument:" + method.FullName + ":" + argument : null;
                if (source == null) continue;
                if (!aliases.ContainsKey(field.FullName)) aliases[field.FullName] = new HashSet<string>();
                if (!aliases.ContainsKey(source)) aliases[source] = new HashSet<string>();
                aliases[field.FullName].Add(source); aliases[source].Add(field.FullName);
            }
        var readers = Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody).SelectMany(m => m.Body.Instructions
            .Where(i => i.Operand is MethodReference && TextControl(((MethodReference)i.Operand).DeclaringType) && ((MethodReference)i.Operand).Name == "get_text")
            .Select(i => new { Receiver = Receiver(i, 0), Proof = Trace(m, i.Next, 0, 0) })).ToList();
        foreach (var method in Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody))
            foreach (var instruction in method.Body.Instructions)
            {
                var field = instruction.Operand as FieldReference;
                if (instruction.OpCode != OpCodes.Ldfld || field == null || field.FieldType.FullName != "System.String") continue;
                var proof = Trace(method, instruction.Next, 0, 0);
                if (Readback(method.DeclaringType)) proof.Unsafe = true;
                var reachable = new HashSet<string>(proof.Receivers); var queue = new Queue<string>(reachable);
                while (queue.Count > 0) { var key = queue.Dequeue(); HashSet<string> neighbours;
                    if (aliases.TryGetValue(key, out neighbours)) foreach (var neighbour in neighbours) if (reachable.Add(neighbour)) queue.Enqueue(neighbour); }
                if (readers.Any(reader => reader.Receiver != null && reachable.Contains(reader.Receiver) && (!reader.Proof.Display || reader.Proof.Unsafe))) proof.Unsafe = true;
                result.Add(new Site { Id = "display-site-v1:" + Hash(assemblyHash + "\0" + method.FullName + "\0" + instruction.Offset + "\0" + field.FullName),
                    Field = field, Method = method, Load = instruction, Proof = proof });
            }
        var stores = PresentationSites(module, assemblyHash).ToArray();
        foreach (var site in GetterSites(module, assemblyHash).Concat(stores).Concat(ArrayElementSites(module, assemblyHash)).Concat(PresentationSliceSites(module, assemblyHash, stores)))
        {
            var reachable = new HashSet<string>(site.Proof.Receivers); var queue = new Queue<string>(reachable);
            while (queue.Count > 0) { var key = queue.Dequeue(); HashSet<string> neighbours;
                if (aliases.TryGetValue(key, out neighbours)) foreach (var neighbour in neighbours) if (reachable.Add(neighbour)) queue.Enqueue(neighbour); }
            if (readers.Any(reader => reader.Receiver != null && reachable.Contains(reader.Receiver) && (!reader.Proof.Display || reader.Proof.Unsafe))) site.Proof.Unsafe = true;
            result.Add(site);
        }
        return result;
    }
    static IEnumerable<Site> GetterSites(ModuleDefinition module, string assemblyHash)
    {
        var getters = new Dictionary<string, FieldReference>();
        foreach (var getter in Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody && m.IsGetter && m.HasThis && !m.IsVirtual && m.Parameters.Count == 0 && m.ReturnType.FullName == "System.String"))
        {
            var body = getter.Body.Instructions.Where(i => i.OpCode != OpCodes.Nop).ToArray();
            var field = body.Length == 3 ? body[1].Operand as FieldReference : null;
            if (field != null && body[0].OpCode == OpCodes.Ldarg_0 && body[1].OpCode == OpCodes.Ldfld && body[2].OpCode == OpCodes.Ret && field.FieldType.FullName == "System.String") getters[getter.FullName] = field;
        }
        foreach (var method in Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody)) foreach (var load in method.Body.Instructions)
        {
            var getter = load.Operand as MethodReference; FieldReference field;
            if ((load.OpCode != OpCodes.Call && load.OpCode != OpCodes.Callvirt) || getter == null || !getters.TryGetValue(getter.FullName, out field)) continue;
            var proof = Trace(method, load.Next, 0, 0);
            if (Readback(method.DeclaringType)) proof.Unsafe = true;
            yield return new Site { Id = "display-site-v1:" + Hash(assemblyHash + "\0getter-result\0" + method.FullName + "\0" + load.Offset + "\0" + field.FullName),
                Kind = "getter-result", Field = field, Method = method, Load = load, Proof = proof };
        }
    }
    static IEnumerable<Tuple<string[], FieldDefinition>> StringFields(TypeDefinition type, string[] prefix, HashSet<string> visited)
    {
        if (prefix.Length > 16 || type == null || !visited.Add(type.FullName)) yield break;
        foreach (var field in type.Fields.Where(f => !f.IsStatic))
        {
            var path = prefix.Concat(new [] { field.Name }).ToArray();
            var item = field.FieldType;
            if (item.FullName == "System.String") { yield return Tuple.Create(path, field); continue; }
            if (item is ArrayType) { item = ((ArrayType)item).ElementType; path = path.Concat(new [] { "*" }).ToArray(); }
            else if (item is GenericInstanceType && ((GenericInstanceType)item).GenericArguments.Count == 1 && item.Namespace == "System.Collections.Generic")
            { item = ((GenericInstanceType)item).GenericArguments[0]; path = path.Concat(new [] { "*" }).ToArray(); }
            TypeDefinition nested = null; try { nested = item.Resolve(); } catch { }
            if (nested != null && nested.Module == type.Module)
                foreach (var child in StringFields(nested, path, new HashSet<string>(visited))) yield return child;
        }
    }
    static IEnumerable<FieldDefinition> SerializedMetadataFields(TypeDefinition type)
    {
        var seen = new HashSet<string>();
        for (int depth = 0; type != null && depth < 32 && seen.Add(type.FullName); depth++)
        {
            foreach (var field in type.Fields.Where(f => !f.IsStatic && !f.IsInitOnly && !f.IsNotSerialized &&
                (f.IsPublic || f.CustomAttributes.Any(a => a.AttributeType.FullName == "UnityEngine.SerializeField")))) yield return field;
            try { type = type.BaseType == null ? null : type.BaseType.Resolve(); } catch { yield break; }
        }
    }
    static bool UnityObject(TypeDefinition type)
    {
        var seen = new HashSet<string>();
        for (int depth = 0; type != null && depth < 32 && seen.Add(type.FullName); depth++)
        {
            if (type.FullName == "UnityEngine.Object") return true;
            try { type = type.BaseType == null ? null : type.BaseType.Resolve(); } catch { return true; }
        }
        return false;
    }
    static IEnumerable<Tuple<string[], FieldDefinition>> EventMetadataFields(TypeDefinition type, string[] prefix, HashSet<string> visited,
        Dictionary<string, string> dependencies)
    {
        if (type == null || prefix.Length > 16 || !visited.Add(type.Module.Name + ":" + type.FullName)) yield break;
        if (String.IsNullOrEmpty(type.Module.FileName)) yield break;
        if (!dependencies.ContainsKey(type.Module.Name)) dependencies[type.Module.Name] = Hash(File.ReadAllBytes(type.Module.FileName));
        var fields = SerializedMetadataFields(type).ToArray();
        var ambiguous = new HashSet<string>(fields.GroupBy(f => f.Name).Where(g => g.Count() > 1).Select(g => g.Key));
        foreach (var field in fields.Where(f => !ambiguous.Contains(f.Name)))
        {
            var path = prefix.Concat(new [] { field.Name }).ToArray();
            string owner = field.DeclaringType.Module.Assembly.Name.Name;
            if (field.Name == "m_TypeName" && field.FieldType.FullName == "System.String" &&
                field.DeclaringType.FullName == "UnityEngine.Events.UnityEventBase" &&
                (owner == "UnityEngine" || owner == "UnityEngine.CoreModule"))
            {
                var declaringModule = field.DeclaringType.Module;
                if (String.IsNullOrEmpty(declaringModule.FileName)) continue;
                if (!dependencies.ContainsKey(declaringModule.Name)) dependencies[declaringModule.Name] = Hash(File.ReadAllBytes(declaringModule.FileName));
                yield return Tuple.Create(path, field);
                continue;
            }
            var item = field.FieldType;
            if (item.FullName == "System.String" || item.IsPrimitive || item.IsPointer || item.IsByReference) continue;
            if (item is ArrayType) { item = ((ArrayType)item).ElementType; path = path.Concat(new [] { "*" }).ToArray(); }
            else if (item is GenericInstanceType && item.Namespace == "System.Collections.Generic" && item.Name == "List`1")
            { item = ((GenericInstanceType)item).GenericArguments[0]; path = path.Concat(new [] { "*" }).ToArray(); }
            TypeDefinition nested = null; try { nested = item.Resolve(); } catch { }
            if (nested != null && !nested.IsEnum && !UnityObject(nested))
                foreach (var child in EventMetadataFields(nested, path, new HashSet<string>(visited), dependencies)) yield return child;
        }
    }
    static object InspectMetadata(ModuleDefinition module, string assemblyHash, string typeName)
    {
        var type = Types(module.Types).SingleOrDefault(t => t.FullName == typeName);
        if (type == null) throw new InvalidOperationException("Managed component type is missing");
        var dependencies = new Dictionary<string, string>();
        var fields = EventMetadataFields(type, new string[0], new HashSet<string>(), dependencies).Select(entry => new {
            path = entry.Item1, declaringField = entry.Item2.FullName,
            declaringAssembly = entry.Item2.DeclaringType.Module.Name,
            rule = "unity-event-serialized-type-identity"
        }).ToArray();
        return new { schema = "pinhao-unity-event-metadata-v1", assemblySha256 = assemblyHash, typeName = typeName,
            dependencyAssemblies = dependencies, metadataFields = fields };
    }
    static object Inspect(ModuleDefinition module, string assemblyHash, string typeName)
    {
        var type = Types(module.Types).SingleOrDefault(t => t.FullName == typeName);
        if (type == null) throw new InvalidOperationException("Managed component type is missing");
        var sites = Sites(module, assemblyHash);
        return new { schema = "pinhao-unity-field-uses-v1", assemblySha256 = assemblyHash, typeName = typeName,
            scope = "Bounded string consumer proof with field-only getters, string locals/helpers and presentation temporaries; unresolved business uses, indirect dispatch and UI text readback remain pending",
            textReadbackSites = Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody).SelectMany(m => m.Body.Instructions
                .Where(i => i.Operand is MethodReference && TextControl(((MethodReference)i.Operand).DeclaringType) && ((MethodReference)i.Operand).Name == "get_text")
                .Select(i => new { method = m.FullName, offset = i.Offset })).ToArray(),
            fields = StringFields(type, new string[0], new HashSet<string>()).Select(entry => new {
                path = entry.Item1, field = entry.Item2.FullName, directRewrite = false,
                uses = sites.Where(s => s.Field.FullName == entry.Item2.FullName).Select(s => new {
                    siteId = s.Id, siteKind = s.Kind, method = s.Method.FullName, offset = s.Store == null ? s.Load.Offset : s.Store.Offset, displayOnly = s.Proof.Display && !s.Proof.Unsafe,
                    display = s.Proof.Display, unresolvedOrBusinessUse = s.Proof.Unsafe, receivers = s.Proof.Receivers.ToArray(), calls = s.Proof.Calls.Distinct().ToArray(), readUses = s.ReadUses
                }).ToArray()
            }).ToArray() };
    }
    static int? Integer(Instruction instruction)
    {
        if (instruction == null) return null;
        switch (instruction.OpCode.Code)
        {
            case Code.Ldc_I4_M1: return -1; case Code.Ldc_I4_0: return 0; case Code.Ldc_I4_1: return 1;
            case Code.Ldc_I4_2: return 2; case Code.Ldc_I4_3: return 3; case Code.Ldc_I4_4: return 4;
            case Code.Ldc_I4_5: return 5; case Code.Ldc_I4_6: return 6; case Code.Ldc_I4_7: return 7; case Code.Ldc_I4_8: return 8;
            case Code.Ldc_I4: case Code.Ldc_I4_S: return Convert.ToInt32(instruction.Operand);
            default: return null;
        }
    }
    static int? Local(Instruction instruction, bool store)
    {
        if (instruction == null) return null;
        if (store) switch (instruction.OpCode.Code) { case Code.Stloc_0: return 0; case Code.Stloc_1: return 1; case Code.Stloc_2: return 2; case Code.Stloc_3: return 3;
            case Code.Stloc: case Code.Stloc_S: return ((VariableDefinition)instruction.Operand).Index; }
        else switch (instruction.OpCode.Code) { case Code.Ldloc_0: return 0; case Code.Ldloc_1: return 1; case Code.Ldloc_2: return 2; case Code.Ldloc_3: return 3;
            case Code.Ldloc: case Code.Ldloc_S: return ((VariableDefinition)instruction.Operand).Index; }
        return null;
    }
    static IEnumerable<CodeGroup> CodeGroups(ModuleDefinition module, string assemblyHash)
    {
        foreach (var method in Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody))
            foreach (var allocation in method.Body.Instructions.Where(i => i.OpCode == OpCodes.Newarr && ((TypeReference)i.Operand).FullName == "System.String"))
            {
                int? size = Integer(allocation.Previous); if (!size.HasValue || size < 1) continue;
                var group = new CodeGroup { Method = method, AllocationOffset = allocation.Offset }; Instruction segment = null; bool complete = false;
                int? arrayLocal = Local(allocation.Next, true);
                for (var instruction = allocation.Next; instruction != null; instruction = instruction.Next)
                {
                    if (instruction.OpCode == OpCodes.Newarr || instruction.OpCode.FlowControl == FlowControl.Return || instruction.OpCode.FlowControl == FlowControl.Branch || instruction.OpCode.FlowControl == FlowControl.Cond_Branch) break;
                    if (instruction.OpCode == OpCodes.Dup || arrayLocal.HasValue && Local(instruction, false) == arrayLocal) segment = instruction;
                    if (instruction.OpCode == OpCodes.Stelem_Ref && segment != null)
                    {
                        int? index = Integer(segment.Next); var value = segment.Next == null ? null : segment.Next.Next;
                        if (!index.HasValue || index < 0 || index >= size || value == null) break;
                        var expression = new List<Instruction>(); for (var part = value; part != null && part != instruction; part = part.Next) expression.Add(part);
                        bool literal = expression.Count == 1 && expression[0].OpCode == OpCodes.Ldstr;
                        group.Elements.Add(new CodeElement { Index = index.Value, Source = literal ? (string)value.Operand : null, Supported = literal,
                            Offsets = expression.Where(i => i.OpCode == OpCodes.Ldstr).Select(i => i.Offset).ToArray(),
                            Reason = literal ? null : "Dynamic or concatenated array element requires a complete template adapter; literal fragments are not text units" });
                        segment = null;
                    }
                    var field = instruction.Operand as FieldReference;
                    if (instruction.OpCode == OpCodes.Stfld && field != null && field.FieldType.FullName == "System.String[]")
                    { group.ArrayField = field.FullName; complete = group.Elements.Count == size && group.Elements.Select(e => e.Index).Distinct().Count() == size; break; }
                }
                if (!complete) continue;
                group.Id = "managed-code-v1:" + Hash(assemblyHash + "\0" + method.FullName + "\0" + allocation.Offset + "\0" + group.ArrayField);
                yield return group;
            }
    }
    static object InspectCode(ModuleDefinition module, string assemblyHash)
    {
        var sites = Sites(module, assemblyHash).Where(s => s.Kind == "presentation-store" || s.Kind == "array-element" || s.Kind == "presentation-slice").ToArray();
        var arrays = new HashSet<string>(Types(module.Types).SelectMany(t => t.Fields).Where(f => f.FieldType.FullName == "System.String[]").Select(f => f.FullName));
        var copies = new Dictionary<string, HashSet<string>>();
        foreach (var method in Types(module.Types).SelectMany(t => t.Methods).Where(m => m.HasBody)) foreach (var instruction in method.Body.Instructions)
        {
            if (instruction.OpCode != OpCodes.Stelem_Ref || instruction.Previous == null || instruction.Previous.OpCode != OpCodes.Ldelem_Ref) continue;
            string source = Receiver(instruction.Previous, 1), destination = Receiver(instruction, 2);
            if (source == null || destination == null || !arrays.Contains(source) || !arrays.Contains(destination)) continue;
            if (!copies.ContainsKey(source)) copies[source] = new HashSet<string>(); copies[source].Add(destination);
        }
        return new { schema = "pinhao-unity-code-text-v1", assemblySha256 = assemblyHash,
            scope = "Bounded typewriter protocol: complete string-array element to a presentation store; Length metadata, Substring display and explicit UnityEngine.Debug.Log(Object) diagnostic reads are reported for Agent adjudication, not a whole-program numerical taint proof. Unsupported templates stay pending.",
            groups = CodeGroups(module, assemblyHash).Select(g => {
                var reachable = new HashSet<string> { g.ArrayField }; var queue = new Queue<string>(reachable);
                while (queue.Count > 0) { var current = queue.Dequeue(); HashSet<string> next; if (copies.TryGetValue(current, out next)) foreach (var target in next) if (reachable.Add(target)) queue.Enqueue(target); }
                return new { groupId = g.Id, method = g.Method.FullName, methodToken = g.Method.MetadataToken.ToInt32(), allocationOffset = g.AllocationOffset, arrayField = g.ArrayField,
                    elements = g.Elements.OrderBy(e => e.Index).Select(e => new { index = e.Index, source = e.Source, expressionKind = e.Supported ? "literal" : "unsupported-template", supported = e.Supported, sourceOffsets = e.Offsets, reason = e.Reason }).ToArray(),
                    displaySites = sites.Where(s => reachable.Contains(s.ArrayField)).Select(s => new { siteId = s.Id, siteKind = s.Kind, field = s.Field.FullName, method = s.Method.FullName,
                        offset = s.Store == null ? s.Load.Offset : s.Store.Offset, arrayField = s.ArrayField, display = s.Proof.Display, displayOnly = s.Proof.Display && !s.Proof.Unsafe, unresolvedOrBusinessUse = s.Proof.Unsafe,
                        calls = s.Proof.Calls.Distinct().ToArray(), receivers = s.Proof.Receivers.ToArray(), readUses = s.ReadUses }).ToArray(),
                    unsupportedTemplates = g.Elements.Count(e => !e.Supported) };
            }).ToArray() };
    }
    static OpCode BranchForm(OpCode opcode)
    {
        switch (opcode.Code)
        {
            case Code.Br_S: return OpCodes.Br;
            case Code.Brfalse_S: return OpCodes.Brfalse;
            case Code.Brtrue_S: return OpCodes.Brtrue;
            case Code.Beq_S: return OpCodes.Beq;
            case Code.Bge_S: return OpCodes.Bge;
            case Code.Bgt_S: return OpCodes.Bgt;
            case Code.Ble_S: return OpCodes.Ble;
            case Code.Blt_S: return OpCodes.Blt;
            case Code.Bne_Un_S: return OpCodes.Bne_Un;
            case Code.Bge_Un_S: return OpCodes.Bge_Un;
            case Code.Bgt_Un_S: return OpCodes.Bgt_Un;
            case Code.Ble_Un_S: return OpCodes.Ble_Un;
            case Code.Blt_Un_S: return OpCodes.Blt_Un;
            case Code.Leave_S: return OpCodes.Leave;
            default: return opcode;
        }
    }
    static string Bodies(ModuleDefinition module, bool strip)
    {
        var rows = new List<string>();
        foreach (var method in Types(module.Types).Where(t => t.FullName != GeneratedType).SelectMany(t => t.Methods).Where(m => m.HasBody))
        {
            var instructions = method.Body.Instructions.ToList();
            var prefixCalls = new HashSet<Instruction>();
            if (strip) for (int index = instructions.Count - 1; index >= 0; index--)
            {
                var call = instructions[index].Operand as MethodReference;
                if (instructions[index].OpCode == OpCodes.Call && call != null && call.DeclaringType.FullName == GeneratedType)
                {
                    if (index < 1 || instructions[index - 1].OpCode != OpCodes.Ldstr) throw new InvalidOperationException("Display patch shape changed");
                    if (call.Name == "Prefix") { prefixCalls.Add(instructions[index]); instructions.RemoveAt(index - 1); index--; continue; }
                    instructions.RemoveAt(index); instructions.RemoveAt(index - 1); index--;
                }
            }
            rows.Add(method.FullName + ":" + method.Body.InitLocals + ":" + String.Join(",", method.Body.Variables.Select(v => v.VariableType.FullName)) + ":" +
                String.Join("|", instructions.Select(i => (prefixCalls.Contains(i) ? OpCodes.Callvirt : BranchForm(i.OpCode)).Name + ":" + Operand(prefixCalls.Contains(i) ? Substring(module) : i.Operand, instructions))) + ":" +
                String.Join("|", method.Body.ExceptionHandlers.Select(h => h.HandlerType + ":" + h.CatchType + ":" +
                    Operand(h.TryStart, instructions) + ":" + Operand(h.TryEnd, instructions) + ":" + Operand(h.HandlerStart, instructions) + ":" +
                    Operand(h.HandlerEnd, instructions) + ":" + Operand(h.FilterStart, instructions))));
        }
        return Hash(String.Join("\n", rows));
    }
    static string Operand(object operand, List<Instruction> instructions)
    {
        if (operand is Instruction) return "@" + instructions.IndexOf((Instruction)operand);
        if (operand is Instruction[]) return String.Join(",", ((Instruction[])operand).Select(i => instructions.IndexOf(i).ToString()));
        return operand == null ? "" : operand.ToString();
    }
    static MethodDefinition PrefixHelper(ModuleDefinition module, TypeDefinition generated, MethodDefinition map)
    {
        var prefix = new MethodDefinition("Prefix", MethodAttributes.Assembly | MethodAttributes.Static, module.TypeSystem.String);
        foreach (var item in new [] { Tuple.Create("value", module.TypeSystem.String), Tuple.Create("start", module.TypeSystem.Int32),
            Tuple.Create("count", module.TypeSystem.Int32), Tuple.Create("site", module.TypeSystem.String) })
            prefix.Parameters.Add(new ParameterDefinition(item.Item1, ParameterAttributes.None, item.Item2));
        generated.Methods.Add(prefix);
        prefix.Body.InitLocals = true;
        prefix.Body.Variables.Add(new VariableDefinition(module.TypeSystem.String));
        prefix.Body.Variables.Add(new VariableDefinition(module.TypeSystem.String));
        prefix.Body.Variables.Add(new VariableDefinition(module.TypeSystem.Int32));
        var length = new MethodReference("get_Length", module.TypeSystem.Int32, module.TypeSystem.String) { HasThis = true };
        var chars = new MethodReference("get_Chars", module.TypeSystem.Char, module.TypeSystem.String) { HasThis = true };
        chars.Parameters.Add(new ParameterDefinition(module.TypeSystem.Int32));
        var high = new MethodReference("IsHighSurrogate", module.TypeSystem.Boolean, module.TypeSystem.Char) { HasThis = false };
        high.Parameters.Add(new ParameterDefinition(module.TypeSystem.Char));
        var low = new MethodReference("IsLowSurrogate", module.TypeSystem.Boolean, module.TypeSystem.Char) { HasThis = false };
        low.Parameters.Add(new ParameterDefinition(module.TypeSystem.Char));
        var il = prefix.Body.GetILProcessor();
        var original = il.Create(OpCodes.Ldloc_0); var full = il.Create(OpCodes.Ldloc_1);
        var boundary = il.Create(OpCodes.Ldloc_2); var finish = il.Create(OpCodes.Ldloc_1);
        // Validate through the original call first: null, negative and out-of-range arguments keep their exceptions.
        il.Append(il.Create(OpCodes.Ldarg_0)); il.Append(il.Create(OpCodes.Ldarg_1)); il.Append(il.Create(OpCodes.Ldarg_2));
        il.Append(il.Create(OpCodes.Callvirt, Substring(module))); il.Append(il.Create(OpCodes.Stloc_0));
        il.Append(il.Create(OpCodes.Ldarg_1)); il.Append(il.Create(OpCodes.Brtrue, original));
        il.Append(il.Create(OpCodes.Ldarg_0)); il.Append(il.Create(OpCodes.Ldarg_3)); il.Append(il.Create(OpCodes.Call, map)); il.Append(il.Create(OpCodes.Stloc_1));
        il.Append(il.Create(OpCodes.Ldloc_1)); il.Append(il.Create(OpCodes.Ldarg_0)); il.Append(il.Create(OpCodes.Ceq)); il.Append(il.Create(OpCodes.Brtrue, original));
        il.Append(il.Create(OpCodes.Ldarg_0)); il.Append(il.Create(OpCodes.Callvirt, length)); il.Append(il.Create(OpCodes.Brfalse, full));
        il.Append(il.Create(OpCodes.Ldarg_2)); il.Append(il.Create(OpCodes.Ldarg_0)); il.Append(il.Create(OpCodes.Callvirt, length)); il.Append(il.Create(OpCodes.Bge, full));
        il.Append(il.Create(OpCodes.Ldarg_2)); il.Append(il.Create(OpCodes.Conv_I8));
        il.Append(il.Create(OpCodes.Ldloc_1)); il.Append(il.Create(OpCodes.Callvirt, length)); il.Append(il.Create(OpCodes.Conv_I8)); il.Append(il.Create(OpCodes.Mul));
        il.Append(il.Create(OpCodes.Ldarg_0)); il.Append(il.Create(OpCodes.Callvirt, length)); il.Append(il.Create(OpCodes.Conv_I8)); il.Append(il.Create(OpCodes.Div));
        il.Append(il.Create(OpCodes.Conv_I4)); il.Append(il.Create(OpCodes.Stloc_2)); il.Append(il.Create(OpCodes.Br, boundary));
        il.Append(full); il.Append(il.Create(OpCodes.Callvirt, length)); il.Append(il.Create(OpCodes.Stloc_2));
        il.Append(boundary); il.Append(il.Create(OpCodes.Ldc_I4_0)); il.Append(il.Create(OpCodes.Ble, finish));
        il.Append(il.Create(OpCodes.Ldloc_2)); il.Append(il.Create(OpCodes.Ldloc_1)); il.Append(il.Create(OpCodes.Callvirt, length)); il.Append(il.Create(OpCodes.Bge, finish));
        il.Append(il.Create(OpCodes.Ldloc_1)); il.Append(il.Create(OpCodes.Ldloc_2)); il.Append(il.Create(OpCodes.Ldc_I4_1)); il.Append(il.Create(OpCodes.Sub));
        il.Append(il.Create(OpCodes.Callvirt, chars)); il.Append(il.Create(OpCodes.Call, high)); il.Append(il.Create(OpCodes.Brfalse, finish));
        il.Append(il.Create(OpCodes.Ldloc_1)); il.Append(il.Create(OpCodes.Ldloc_2)); il.Append(il.Create(OpCodes.Callvirt, chars));
        il.Append(il.Create(OpCodes.Call, low)); il.Append(il.Create(OpCodes.Brfalse, finish));
        il.Append(il.Create(OpCodes.Ldloc_2)); il.Append(il.Create(OpCodes.Ldc_I4_1)); il.Append(il.Create(OpCodes.Sub)); il.Append(il.Create(OpCodes.Stloc_2));
        il.Append(finish); il.Append(il.Create(OpCodes.Ldc_I4_0)); il.Append(il.Create(OpCodes.Ldloc_2)); il.Append(il.Create(OpCodes.Callvirt, Substring(module))); il.Append(il.Create(OpCodes.Ret));
        il.Append(original); il.Append(il.Create(OpCodes.Ret));
        return prefix;
    }
    static object Patch(ModuleDefinition module, string assemblyHash, string planFile, string output)
    {
        var plan = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(planFile, Encoding.UTF8));
        if ((string)plan["assemblySha256"] != assemblyHash) throw new InvalidOperationException("Display source assembly hash changed");
        if (Types(module.Types).Any(t => t.FullName == GeneratedType)) throw new InvalidOperationException("Display patch requires the unmodified source assembly");
        var bindings = ((System.Collections.IEnumerable)plan["bindings"]).Cast<Dictionary<string, object>>().ToList();
        var sites = Sites(module, assemblyHash).ToDictionary(s => s.Id);
        foreach (var binding in bindings)
        { Site site; if (!sites.TryGetValue((string)binding["siteId"], out site) || !site.Proof.Display || site.Proof.Unsafe) throw new InvalidOperationException("Display site lacks an isolated display consumer proof"); }
        var keys = new HashSet<string>();
        foreach (var binding in bindings) if (!keys.Add((string)binding["siteId"] + "\0" + (string)binding["source"])) throw new InvalidOperationException("Conflicting display site/source bindings");
        string before = Bodies(module, false);
        var generated = new TypeDefinition("Pinhao", "GeneratedDisplay", TypeAttributes.NotPublic | TypeAttributes.Abstract | TypeAttributes.Sealed, module.TypeSystem.Object);
        module.Types.Add(generated);
        var map = new MethodDefinition("Map", MethodAttributes.Assembly | MethodAttributes.Static, module.TypeSystem.String);
        map.Parameters.Add(new ParameterDefinition("value", ParameterAttributes.None, module.TypeSystem.String));
        map.Parameters.Add(new ParameterDefinition("site", ParameterAttributes.None, module.TypeSystem.String));
        generated.Methods.Add(map);
        var equality = new MethodReference("op_Equality", module.TypeSystem.Boolean, module.TypeSystem.String) { HasThis = false };
        equality.Parameters.Add(new ParameterDefinition(module.TypeSystem.String)); equality.Parameters.Add(new ParameterDefinition(module.TypeSystem.String));
        var il = map.Body.GetILProcessor();
        foreach (var binding in bindings)
        {
            var next = il.Create(OpCodes.Nop);
            il.Append(il.Create(OpCodes.Ldarg_1)); il.Append(il.Create(OpCodes.Ldstr, (string)binding["siteId"])); il.Append(il.Create(OpCodes.Call, equality)); il.Append(il.Create(OpCodes.Brfalse, next));
            il.Append(il.Create(OpCodes.Ldarg_0)); il.Append(il.Create(OpCodes.Ldstr, (string)binding["source"])); il.Append(il.Create(OpCodes.Call, equality)); il.Append(il.Create(OpCodes.Brfalse, next));
            il.Append(il.Create(OpCodes.Ldstr, (string)binding["translation"])); il.Append(il.Create(OpCodes.Ret)); il.Append(next);
        }
        il.Append(il.Create(OpCodes.Ldarg_0)); il.Append(il.Create(OpCodes.Ret));
        MethodDefinition prefix = null;
        if (bindings.Any(b => sites[(string)b["siteId"]].Kind == "presentation-slice")) prefix = PrefixHelper(module, generated, map);
        foreach (var id in bindings.Select(b => (string)b["siteId"]).Distinct())
        {
            var site = sites[id]; var processor = site.Method.Body.GetILProcessor();
            var label = processor.Create(OpCodes.Ldstr, id);
            if (site.Kind == "presentation-slice")
            { processor.InsertBefore(site.Load, label); site.Load.OpCode = OpCodes.Call; site.Load.Operand = prefix; }
            else { processor.InsertAfter(site.Load, label); processor.InsertAfter(label, processor.Create(OpCodes.Call, map)); }
        }
        // Cecil writes short branch displacements verbatim; insertions can exceed their signed-byte range.
        foreach (var method in bindings.Select(b => sites[(string)b["siteId"]].Method).Distinct())
            foreach (var instruction in method.Body.Instructions) instruction.OpCode = BranchForm(instruction.OpCode);
        module.Write(output);
        using (var actual = ModuleDefinition.ReadModule(output))
        { if (Bodies(actual, true) != before) throw new InvalidOperationException("Display patch changed original business instructions"); }
        return new { schema = "pinhao-unity-display-build-v1", bindings = bindings.Count, sites = bindings.Select(b => (string)b["siteId"]).Distinct().Count(),
            originalBusinessIlUnchanged = true, sourceAssemblySha256 = assemblyHash, outputSha256 = Hash(File.ReadAllBytes(output)) };
    }
    static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            var resolver = new DefaultAssemblyResolver(); resolver.AddSearchDirectory(Path.GetDirectoryName(Path.GetFullPath(args[1])));
            using (var module = ModuleDefinition.ReadModule(args[1], new ReaderParameters { AssemblyResolver = resolver, ReadingMode = ReadingMode.Immediate }))
            {
                if (module.Assembly.Name.HasPublicKey) throw new InvalidOperationException("Signed managed assemblies require a separate display adapter");
                string digest = Hash(File.ReadAllBytes(args[1]));
                Console.WriteLine(Json.Serialize(args[0] == "inspect" ? Inspect(module, digest, args[2]) : args[0] == "inspect-metadata" ? InspectMetadata(module, digest, args[2]) : args[0] == "inspect-code" ? InspectCode(module, digest) : Patch(module, digest, args[2], args[3])));
            }
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.GetType().Name + ": " + error.Message); return 1; }
    }
}
