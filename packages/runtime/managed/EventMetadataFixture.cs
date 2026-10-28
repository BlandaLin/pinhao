using System;
using System.Collections.Generic;

namespace UnityEngine
{
    [AttributeUsage(AttributeTargets.Field)]
    public sealed class SerializeField : Attribute { }
    public class Object { }
}
namespace UnityEngine.Events
{
    public class ArgumentCache { public string m_StringArgument; }
    public class PersistentCall { public ArgumentCache m_Arguments; }
    public class PersistentCallGroup { public PersistentCall[] m_Calls; }
    public class UnityEventBase
    {
        [UnityEngine.SerializeField] private string m_TypeName;
        [UnityEngine.SerializeField] private PersistentCallGroup m_PersistentCalls;
        public UnityEventBase() { m_TypeName = GetType().AssemblyQualifiedName; }
    }
    public class UnityEvent : UnityEventBase { }
}
namespace Neutral
{
    public class CustomData { public string m_TypeName; }
    public class ShadowEvent : UnityEngine.Events.UnityEventBase
    {
        public string m_TypeName;
        public string Caption;
    }
    public class EventComponent
    {
        public UnityEngine.Events.UnityEvent OnDisplay;
        public UnityEngine.Events.UnityEvent[] EventArray;
        public List<UnityEngine.Events.UnityEvent> EventList;
        public CustomData Data;
        public ShadowEvent Shadow;
        public string m_TypeName;
    }
}
