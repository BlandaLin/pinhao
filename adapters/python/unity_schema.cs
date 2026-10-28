using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using AssetsTools.NET;
using AssetsTools.NET.Extra;

// Reads managed assembly metadata. Game assemblies are never executed.
class UnitySchema
{
    static void Add(List<object> nodes, AssetTypeTemplateField field, int level)
    {
        nodes.Add(new Dictionary<string, object> {
            {"m_Level", level}, {"m_Type", field.Type}, {"m_Name", field.Name},
            {"m_ByteSize", -1}, {"m_Version", 1}, {"m_TypeFlags", field.IsArray ? 1 : 0},
            {"m_MetaFlag", field.IsAligned ? 0x4000 : 0}, {"m_Index", nodes.Count}
        });
        foreach (var child in field.Children) Add(nodes, child, level + 1);
    }

    static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = new System.Text.UTF8Encoding(false);
            if (args.Length != 5) throw new ArgumentException("Choose managed directory, assembly, namespace, class and Unity version");
            string assembly = args[1].EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? args[1] : args[1] + ".dll";
            if (Path.GetFileName(assembly) != assembly) throw new ArgumentException("Choose a managed assembly filename");
            var generator = new MonoCecilTempGenerator(args[0]);
            try
            {
                var fields = generator.Read(Path.Combine(args[0], assembly), args[2], args[3], new UnityVersion(args[4]));
                var nodes = new List<object>();
                foreach (var field in fields) Add(nodes, field, 1);
                Console.WriteLine(new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 }.Serialize(nodes));
            }
            finally { generator.Dispose(); }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 2;
        }
    }
}
