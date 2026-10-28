using System;
using System.Collections.Generic;

namespace UnityEngine.UI
{
    public class Text
    {
        public string LastSet;
        public string text { get { return LastSet; } set { LastSet = value; } }
    }
}
namespace UnityEngine
{
    public static class Debug
    {
        public static object Last;
        public static void Log(object value) { Last = value; }
    }
}
namespace TMPro
{
    public class TMP_Text
    {
        public string LastSet;
        public string text { get { return LastSet; } set { LastSet = value; } }
    }
}
namespace Neutral
{
    public static class Keys
    {
        public static readonly List<string> Saved = new List<string>();
        public static void Save(string key) { Saved.Add(key); }
    }
    public class Message
    {
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Show(string title, bool success)
        {
            if (success) Label.text = title + " accepted";
            else Label.text = title + " declined";
        }
    }
    public class Choice
    {
        public string Identity = "Neutral item";
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public Message Message = new Message();
        public void Show() { try { Label.text = Identity; } finally { Keys.Save(Identity); } }
        public void Buy(bool success) { Message.Show(Identity, success); Keys.Save(Identity); }
        public bool Matches() { return Identity == "Neutral item"; }
    }
    public class GetterChoice
    {
        public string Identity = "Neutral getter item";
        public string Title { get { return Identity; } }
        public TMPro.TMP_Text Label = new TMPro.TMP_Text();
        public void Show() { Label.text = Title; }
        public void Save() { Keys.Save(Title); }
    }
    public class GetterReadback
    {
        public string Identity = "Neutral getter item";
        public string Title { get { return Identity; } }
        public TMPro.TMP_Text Label = new TMPro.TMP_Text();
        public void Show() { Label.text = Title; Keys.Save(Label.text); }
    }
    public class GetterLengthBusiness
    {
        public string Identity = "Neutral reward identity";
        public string Title { get { return Identity; } }
        public LengthBusinessMessage Message = new LengthBusinessMessage();
        public void Show() { Message.Show(Title); }
    }
    public class LengthBusinessMessage
    {
        public string Current;
        public TMPro.TMP_Text Label = new TMPro.TMP_Text();
        public void Show(string text) { Current = text; }
        public void Render() { Label.text = Current; }
        public int Reward() { return Current.Length; }
    }
    public class GetterLengthBranchBusiness
    {
        public string Identity = "Neutral branch reward identity";
        public string Title { get { return Identity; } }
        public LengthBranchBusinessMessage Message = new LengthBranchBusinessMessage();
        public void Show() { Message.Show(Title); }
    }
    public class LengthBranchBusinessMessage
    {
        public string Current;
        public int Reward;
        public TMPro.TMP_Text Label = new TMPro.TMP_Text();
        public void Show(string text) { Current = text; }
        public void Render() { if (Current.Length > 8) Reward = 100; Label.text = Current.Substring(0, 1); }
    }
    public class ShortBranchChoice
    {
        public string Identity = "Neutral item";
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public int Counter;
        public void Show(bool visible)
        {
            if (visible)
            {
                Label.text = Identity;
                Counter++; Counter++; Counter++; Counter++; Counter++; Counter++;
                Label.text = Identity;
            }
        }
    }
    public class ReadbackChoice
    {
        public string Identity = "Neutral item";
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Show() { Label.text = Identity; Keys.Save(Label.text); }
    }
    public class CrossChoice
    {
        public string Identity = "Neutral item";
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Show() { Label.text = Identity; }
    }
    public class CrossReader
    {
        public void Read(CrossChoice source) { Keys.Save(source.Label.text); }
    }
    public class VirtualMessage
    {
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public virtual void Show(string title) { Label.text = title; }
    }
    public class OverrideMessage : VirtualMessage
    {
        public override void Show(string title) { Keys.Save(title); }
    }
    public class VirtualChoice
    {
        public string Identity = "Neutral item";
        public VirtualMessage Message = new OverrideMessage();
        public void Show() { Message.Show(Identity); }
    }
    public class AliasWriter
    {
        public string StorageKey = "Neutral item";
        public UnityEngine.UI.Text Label;
        public void Render() { Label.text = StorageKey; }
    }
    public class AliasReader
    {
        public UnityEngine.UI.Text Input;
        public bool IsAccepted() { return Input.text == "Neutral item"; }
    }
    public static class Wiring
    {
        public static void Bind(AliasWriter writer, AliasReader reader, UnityEngine.UI.Text shared)
        { writer.Label = shared; reader.Input = shared; }
    }
    public class Typewriter
    {
        public string[] Lines;
        public string Current;
        public string PlayerName = "Reader";
        public float Duration;
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Prepare() { Lines = new [] { "Neutral first sentence.", "Neutral second sentence.", "Hello " + PlayerName + "." }; }
        public void Next(int index) { Current = Lines[index]; Duration = Current.Length * 0.1f; }
        public void Render(int count) { Label.text = Current.Substring(0, count); }
        public void Diagnostic() { UnityEngine.Debug.Log(Current); }
    }
    public class BusinessTypewriter
    {
        public string[] Lines;
        public string Current;
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Prepare() { Lines = new [] { "Neutral identity sentence." }; }
        public void Next(int index) { Current = Lines[index]; }
        public void Render() { Label.text = Current.Substring(0, Current.Length); }
        public void Save() { Keys.Save(Current); }
        public bool Matches() { return Current == "Neutral identity sentence."; }
    }
    public class DisplayTypewriter
    {
        public string[] Lines;
        public string Current;
        public string PlayerName = "Reader";
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Prepare() { Lines = new [] { "Neutral first sentence.", "Neutral second sentence.", "Hello " + PlayerName + "." }; }
        public void Next(int index) { Current = Lines[index]; }
        public void Render(int count) { Label.text = Current.Substring(0, count); }
        public void RenderAll() { Label.text = Current.Substring(0, Current.Length); }
        public void Diagnostic() { UnityEngine.Debug.Log(Current); }
    }
    public class DirectArray
    {
        public string[] Lines = new [] { "Neutral array sentence." };
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Render(int index) { Label.text = Lines[index]; }
        public void Save() { Keys.Save(Lines[0]); }
    }
    public static class UnknownLog { public static object Last; public static void Write(object value) { Last = value; } }
    public class UnknownDiagnosticTypewriter
    {
        public string[] Lines;
        public string Current;
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Prepare() { Lines = new [] { "Neutral uncertain sentence." }; }
        public void Next(int index) { Current = Lines[index]; }
        public void Render() { Label.text = Current.Substring(0, Current.Length); }
        public void Diagnostic() { UnknownLog.Write(Current); }
    }
    public class PrefixTypewriter
    {
        public string[] Lines;
        public string Current;
        public float Duration;
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Prepare() { Lines = new [] { "abcdef" }; }
        public void Next() { Current = Lines[0]; Duration = Current.Length * 0.1f; }
        public void Render(int count) { Label.text = Current.Substring(0, count); }
        public void RenderMiddle(int count) { Label.text = Current.Substring(1, count); }
        public int Reward() { return Current.Length; }
        public void Save() { Keys.Save(Current); }
        public void Diagnostic() { UnknownLog.Write(Current); }
    }
    public class PrefixReadback
    {
        public string[] Lines;
        public string Current;
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Prepare() { Lines = new [] { "Readback identity" }; }
        public void Next() { Current = Lines[0]; }
        public void Render(int count) { Label.text = Current.Substring(0, count); }
        public void Save() { Keys.Save(Label.text); }
    }
    public class PrefixCrossReadback
    {
        public string[] Lines;
        public string Current;
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Prepare() { Lines = new [] { "Cross-reader identity" }; }
        public void Next() { Current = Lines[0]; }
        public void Render(int count) { Label.text = Current.Substring(0, count); }
    }
    public class PrefixCrossReader
    {
        public void Read(PrefixCrossReadback source) { Keys.Save(source.Label.text); }
    }
    class Program
    {
        static void Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "prefix")
            {
                var writer = new PrefixTypewriter(); writer.Prepare(); writer.Next(); writer.Render(6); writer.Save(); writer.Diagnostic();
                Console.WriteLine(writer.Label.LastSet); Console.WriteLine(writer.Current); Console.WriteLine(writer.Lines[0]);
                Console.WriteLine(writer.Duration.ToString("F1", System.Globalization.CultureInfo.InvariantCulture));
                Console.WriteLine(writer.Reward()); Console.WriteLine(Keys.Saved[0]); Console.WriteLine(UnknownLog.Last);
                writer.RenderMiddle(2); Console.WriteLine(writer.Label.LastSet);
                for (int count = 0; count <= 6; count++) { writer.Render(count); Console.WriteLine(Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(writer.Label.LastSet))); }
                return;
            }
            if (args.Length > 0 && args[0] == "prefix-errors")
            {
                var writer = new PrefixTypewriter(); writer.Prepare(); writer.Next();
                foreach (int count in new [] { -1, 7, Int32.MaxValue })
                    try { writer.Render(count); Console.WriteLine("no-error"); }
                    catch (ArgumentOutOfRangeException error) { Console.WriteLine(error.GetType().Name + ":" + error.ParamName); }
                writer.Current = null;
                try { writer.Render(0); Console.WriteLine("no-error"); }
                catch (NullReferenceException error) { Console.WriteLine(error.GetType().Name); }
                return;
            }
            if (args.Length > 0 && args[0] == "getter")
            {
                var getterChoice = new GetterChoice(); getterChoice.Show(); getterChoice.Save();
                Console.WriteLine(getterChoice.Label.LastSet); Console.WriteLine(getterChoice.Title); Console.WriteLine(Keys.Saved[0]); return;
            }
            if (args.Length > 0 && args[0] == "array")
            {
                var direct = new DirectArray(); direct.Render(0); direct.Save();
                Console.WriteLine(direct.Label.LastSet); Console.WriteLine(direct.Lines[0]); Console.WriteLine(Keys.Saved[0]); return;
            }
            if (args.Length > 0 && args[0] == "typewriter")
            {
                var writer = new Typewriter(); writer.Prepare(); writer.Next(0); writer.Render(2); writer.Diagnostic();
                Console.WriteLine(writer.Label.LastSet); Console.WriteLine(writer.Duration.ToString("F1", System.Globalization.CultureInfo.InvariantCulture));
                Console.WriteLine(writer.Lines[0]); Console.WriteLine(UnityEngine.Debug.Last);
                writer.Next(1); writer.Render(3); Console.WriteLine(writer.Label.LastSet); return;
            }
            if (args.Length > 0 && args[0] == "display-typewriter")
            {
                var writer = new DisplayTypewriter(); writer.Prepare(); writer.Next(0); writer.Render(2); writer.Diagnostic();
                Console.WriteLine(writer.Label.LastSet); Console.WriteLine(writer.Lines[0]); Console.WriteLine(UnityEngine.Debug.Last);
                writer.Next(1); writer.Render(3); Console.WriteLine(writer.Label.LastSet);
                writer.RenderAll(); Console.WriteLine(writer.Label.LastSet); return;
            }
            if (args.Length > 0 && args[0] == "branch")
            {
                var branch = new ShortBranchChoice(); branch.Show(true); branch.Show(false);
                Console.WriteLine(branch.Label.LastSet); Console.WriteLine(branch.Counter);
                Console.WriteLine(branch.Identity); return;
            }
            var choice = new Choice(); choice.Show(); choice.Buy(true);
            Console.WriteLine(choice.Label.LastSet);
            Console.WriteLine(choice.Message.Label.LastSet);
            Console.WriteLine(choice.Identity);
            Console.WriteLine(String.Join("|", Keys.Saved.ToArray()));
            Console.WriteLine(choice.Matches());
        }
    }
}
namespace Fixture
{
    public class Line { public string caption; public string eventId; }
    public class Chapter { public Line[] lines; }
    public class Command
    {
        public string m_Text, internalTarget, animationCaption;
        public Chapter[] chapters;
        public UnityEngine.UI.Text Label = new UnityEngine.UI.Text();
        public void Display()
        {
            Label.text = m_Text;
            Label.text = animationCaption;
            if (chapters != null) foreach (var chapter in chapters)
                if (chapter.lines != null) foreach (var line in chapter.lines) Label.text = line.caption;
            Neutral.Keys.Save(internalTarget);
        }
    }
}
