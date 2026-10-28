using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;

namespace UnityEngine { public class MonoBehaviour {} }
namespace Fixture
{
    public class State
    {
        public int Coins = 5;
        public double Speed = 1.5;
        public bool Cleared;
        public string Name = "Guide";
        public readonly List<int> Items = new List<int> { 1, 2 };
        public readonly Dictionary<string, int> Variables = new Dictionary<string, int> { { "Chapter", 2 } };
        public int GetterCalls;
        public int Dangerous { get { GetterCalls++; throw new InvalidOperationException("Properties stay untouched"); } }
    }
    public class Controller : UnityEngine.MonoBehaviour
    {
        public readonly State Data = new State();
        public static int StaticScore = 3;
        public void Update() { Thread.Sleep(1); }
    }
}
namespace Yukar.Engine
{
    public class GameMain
    {
        public readonly Fixture.State Data = new Fixture.State();
        public static int StaticScore = 3;
        public void update(float elapsed) { Thread.Sleep(1); }
    }
}
class Program
{
    static void Main(string[] args)
    {
        var unity = new Fixture.Controller();
        var yukar = new Yukar.Engine.GameMain();
        while (!File.Exists(args[1]))
        {
            if (args[0] == "Unity") unity.Update(); else yukar.update(0.016f);
            Thread.Sleep(20);
        }
        var data = args[0] == "Unity" ? unity.Data : yukar.Data;
        File.WriteAllText(args[2], data.Coins + "," + data.Name + "," + data.Cleared + "," + data.Items[0] + "," + data.GetterCalls);
    }
}
