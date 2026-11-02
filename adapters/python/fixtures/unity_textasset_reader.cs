using System;
namespace UnityEngine {
    public class TextAsset { public string text { get { return "a,b,Neutral tail, with comma"; } } }
    public static class Resources { public static T Load<T>(string key) where T : new() { return new T(); } }
}
namespace UnityEngine.UI { public class Text { public string text { get; set; } } }
public sealed class Buffer {
    string value;
    public void Set(string text) { value = text; }
    public Buffer Append(string text) { value = value + text; return this; }
    public override string ToString() { return value; }
}
public static class ReaderFixture {
    public static void Read(UnityEngine.UI.Text ui) {
        var builder = new Buffer();
        foreach (var row in UnityEngine.Resources.Load<UnityEngine.TextAsset>("Neutral/Dialog").text.Split(new[] {'\n'})) {
            var fields = row.Split(new[] {','});
            var body = fields[2];
            if (fields.Length >= 4) {
                builder.Set(body);
                for (var i = 3; i < fields.Length; i++) {
                    builder.Append(",").Append(fields[i]);
                }
                body = builder.ToString();
            }
            ui.text = body;
        }
    }
    public static void Main() { var ui = new UnityEngine.UI.Text(); Read(ui); Console.WriteLine(ui.text); }
}
