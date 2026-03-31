# Enforce Script Language Reference

## Primitive Types

| Type | Description | Example |
|------|-------------|---------|
| `int` | 32-bit integer | `int i = 5;` |
| `float` | 32-bit float | `float f = 3.14;` |
| `bool` | Boolean | `bool b = true;` |
| `string` | Immutable string | `string s = "hello";` |
| `vector` | 3-component float | `vector v = "1 0 1";` |
| `void` | No return type | signatures only |

## String Operations

```enforce
string result = string.Format("Player %1 has %2 kills", playerName, killCount);
string sub = "Hello World".Substring(2, 5);
float val = "42.7".ToFloat();
int ival = "99".ToInt();
string s = n.ToString();
string padded = n.ToString(5);  // "00042"
string empty = string.Empty;
```

## Vector Operations

```enforce
vector v = "1 0 1";
v.Normalize();
float len = v.Length();
float lenSq = v.LengthSq();
float sz = v.NormalizeSize();
float dist = vector.Distance("1 2 3", "4 5 6");
vector zero = vector.Zero;
```

## Arrays

```enforce
array<int> myInts = {};
array<int> myInts2 = new array<int>();
myInts.Insert(10);
myInts.InsertAt(99, 1);
myInts.RemoveItem(10);
myInts.Remove(0);           // by index
int count = myInts.Count();
int val = myInts[0];
int val2 = myInts.Get(0);
myInts.Reserve(100);        // pre-allocate

// Merge
array<string> a1 = {};
array<string> a2 = {};
a1.InsertAll(a2);

// Ref arrays (owning elements)
array<ref SCR_ScoreInfo> m_aScores = {};
```

Common typedefs: `TStringArray`, `TIntArray`, `TFloatArray`

## Maps

```enforce
map<int, string> m = new map<int, string>();
m.Insert(1, "Alpha");
string val = m.Get(1);
if (m.Contains(1)) { ... }

// Remove and retrieve
string removed;
m.Take(1, removed);

// Iterate
MapIterator it = m.Begin();
while (it != m.End()) {
  int k = m.GetIteratorKey(it);
  it = m.Next(it);
}
```

## Enums

```enforce
enum EMyState { IDLE, ACTIVE, DEAD }
EMyState state = EMyState.ACTIVE;

// Bitflag enum (auto: 1, 2, 4, 8...)
[EnumBitFlag]
enum EMyFlags { Item1, Item2, Item3 }

int flags = 0;
flags = SCR_Enum.SetFlag(flags, EMyFlags.Item1);
bool has = SCR_Enum.HasFlag(flags, EMyFlags.Item1);
flags = SCR_Enum.RemoveFlag(flags, EMyFlags.Item1);
```

## Classes and Inheritance

```enforce
class Animal {
  protected string m_sName;

  void Animal(string name) { m_sName = name; }
  void ~Animal() { }  // destructor

  void Speak() { Print("..."); }
}

class Dog : Animal {
  void Dog(string name) { super(name); }

  override void Speak() {
    Print("Woof! I am " + m_sName);
    super.Speak();
  }
}
```

## Access Modifiers

| Modifier | Meaning |
|----------|---------|
| (none) | Public by default |
| `private` | Declaring class only |
| `protected` | Class + subclasses |
| `static` | Belongs to class, not instance |
| `const` | Compile-time constant |
| `sealed` | Class cannot be subclassed |
| `modded` | Extends existing class for modding |

## Generics

```enforce
class MyContainer<Class T> {
  T m_Value;
  void Set(T val) { m_Value = val; }
  T Get() { return m_Value; }
}
```

## Memory Management

```enforce
// ref - strong reference, prevents deletion
ref MyClass m_obj = new MyClass();

// autoptr - auto-deleted when scope exits
autoptr MyClass temp = new MyClass();

// Weak reference (plain variable) - no ownership
MyClass weakRef = someObject;

// notnull parameter - compiler enforces non-null at callsite
void DoWork(notnull MyClass obj) { ... }
```

## Function Modifiers

| Keyword | Meaning |
|---------|---------|
| `proto` | Prototype, implemented in C++ engine |
| `proto native` | Native C++ function |
| `proto external` | External C++ function exposed to script |
| `override` | Overrides parent method |
| `out` | Output parameter (written by callee) |
| `inout` | Input-output parameter |
| `notnull` | Parameter cannot be null |
| `event` | Marks as event handler hook |

## Typedefs and Function Types

```enforce
void OnPlayerDeath(int playerId, IEntity player);
typedef func OnPlayerDeath;
typedef ScriptInvokerBase<OnPlayerDeath> OnPlayerDeathInvoker;
```

## Control Flow

```enforce
// Standard C-style
if (cond) { } else if (cond2) { } else { }
for (int i = 0; i < n; i++) { }
while (cond) { }
do { } while (cond);
switch (val) { case 1: break; default: break; }
foreach (int item : myArray) { }
```

## Preprocessor

```enforce
#ifdef WORKBENCH
  // Workbench editor only
#endif

#ifdef BUILD_RELEASE
  // Release builds only
#endif
```

## Access Levels

```enforce
[Obsolete("Use NewMethod() instead")]   // compile warning
[Friend(OtherClass)]                    // access to protected members
```
