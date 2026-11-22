$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class ABRoute {
 [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class Enumerator{}
 [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IEnum{[PreserveSig]int EnumAudioEndpoints(int flow,int mask,out ICollection col);[PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out IDevice dev);}
 [ComImport,Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface ICollection{[PreserveSig]int GetCount(out uint count);[PreserveSig]int Item(uint index,out IDevice device);}
 [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface IDevice{[PreserveSig]int Activate(ref Guid iid,int ctx,IntPtr ap,out IntPtr obj);[PreserveSig]int OpenPropertyStore(int access,out IStore store);[PreserveSig]int GetId([MarshalAs(UnmanagedType.LPWStr)]out string id);[PreserveSig]int GetState(out int state);}
 [StructLayout(LayoutKind.Sequential)]public struct PKey{public Guid fmtid;public uint pid;}
 [StructLayout(LayoutKind.Explicit)]public struct PV{[FieldOffset(0)]public ushort vt;[FieldOffset(8)]public IntPtr pointer;}
 [ComImport,Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IStore{[PreserveSig]int GetCount(out uint n);[PreserveSig]int GetAt(uint n,out PKey key);[PreserveSig]int GetValue(ref PKey key,out PV val);}
 [DllImport("ole32.dll")]static extern int PropVariantClear(ref PV p);
 [ComImport,Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]public class PolicyClient{}
 [ComImport,Guid("F8679F50-850A-41CF-9C72-430F290290C8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]public interface IPolicy{
  [PreserveSig]int GetMixFormat(IntPtr a,IntPtr b);[PreserveSig]int GetDeviceFormat(IntPtr a,int b,IntPtr c);[PreserveSig]int ResetDeviceFormat(IntPtr a);[PreserveSig]int SetDeviceFormat(IntPtr a,IntPtr b,IntPtr c);[PreserveSig]int GetProcessingPeriod(IntPtr a,int b,IntPtr c,IntPtr d);[PreserveSig]int SetProcessingPeriod(IntPtr a,IntPtr b);[PreserveSig]int GetShareMode(IntPtr a,IntPtr b);[PreserveSig]int SetShareMode(IntPtr a,IntPtr b);[PreserveSig]int GetPropertyValue(IntPtr a,int b,IntPtr c,IntPtr d);[PreserveSig]int SetPropertyValue(IntPtr a,int b,IntPtr c,IntPtr d);[PreserveSig]int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)]string id,int role);[PreserveSig]int SetEndpointVisibility(IntPtr a,int b);
 }
 public static string[] Snapshot(string fallbackLabel){var e=(IEnum)new Enumerator();var result=new string[5];string desired=fallbackLabel??"";if(desired.EndsWith(" (Bluetooth)",StringComparison.OrdinalIgnoreCase))desired=desired.Substring(0,desired.Length-12);for(int r=0;r<3;r++){IDevice d;if(e.GetDefaultAudioEndpoint(0,r,out d)==0)d.GetId(out result[r]);}ICollection col;Marshal.ThrowExceptionForHR(e.EnumAudioEndpoints(0,1,out col));uint n;col.GetCount(out n);for(uint i=0;i<n;i++){IDevice d;col.Item(i,out d);IStore s;d.OpenPropertyStore(0,out s);var k=new PKey{fmtid=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),pid=14};PV v;s.GetValue(ref k,out v);string name=Marshal.PtrToStringUni(v.pointer)??"";PropVariantClear(ref v);if(name.StartsWith("CABLE Input (VB-Audio",StringComparison.OrdinalIgnoreCase))d.GetId(out result[3]);if(!string.IsNullOrWhiteSpace(desired)&&name.Equals(desired,StringComparison.OrdinalIgnoreCase))d.GetId(out result[4]);}return result;}
 public class Endpoint {
  public string Id { get; set; }
  public string Label { get; set; }
 }
 public static Endpoint[] Devices(int flow){
  var e=(IEnum)new Enumerator();
  ICollection collection;
  Marshal.ThrowExceptionForHR(e.EnumAudioEndpoints(flow,1,out collection));
  uint count;
  Marshal.ThrowExceptionForHR(collection.GetCount(out count));
  var items=new System.Collections.Generic.List<Endpoint>();
  var key=new PKey{fmtid=new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"),pid=14};
  for(uint i=0;i<count;i++){
   IDevice device; IStore store; PV value; string id;
   if(collection.Item(i,out device)<0 || device.GetId(out id)<0 ||
      device.OpenPropertyStore(0,out store)<0 || store.GetValue(ref key,out value)<0)continue;
   string label=Marshal.PtrToStringUni(value.pointer)??"";
   PropVariantClear(ref value);
   if(label.Length>0)items.Add(new Endpoint{Id=id,Label=label});
  }
  return items.ToArray();
 }
 public static string Default(int flow,int role){
  var e=(IEnum)new Enumerator(); IDevice device; string id;
  return e.GetDefaultAudioEndpoint(flow,role,out device)==0 && device.GetId(out id)==0?id:null;
 }
 public static bool Available(){return (new PolicyClient() as IPolicy)!=null;}
 public static void Set(string id,int role){if(string.IsNullOrWhiteSpace(id)||role<0||role>2)throw new ArgumentException("invalid endpoint");var p=(IPolicy)new PolicyClient();Marshal.ThrowExceptionForHR(p.SetDefaultEndpoint(id,role));}
}
'@
if($env:AB_ROUTE_ACTION -eq 'snapshot') { $x=[ABRoute]::Snapshot($env:AB_ROUTE_FALLBACK);@{roles=@($x[0],$x[1],$x[2]);cable=$x[3];fallback=$x[4]} | ConvertTo-Json -Compress }
elseif($env:AB_ROUTE_ACTION -eq 'check') { @{available=[ABRoute]::Available()} | ConvertTo-Json -Compress }
elseif($env:AB_ROUTE_ACTION -eq 'devices') {
 @{outputs=@([ABRoute]::Devices(0));inputs=@([ABRoute]::Devices(1));defaultOutput=[ABRoute]::Default(0,1);communicationOutput=[ABRoute]::Default(0,2);communicationInput=[ABRoute]::Default(1,2)} | ConvertTo-Json -Compress -Depth 4
}
elseif($env:AB_ROUTE_ACTION -eq 'set') { $ops=$env:AB_ROUTE_OPERATIONS | ConvertFrom-Json;foreach($op in $ops){[ABRoute]::Set([string]$op.id,[int]$op.role)};'{"ok":true}' }
else {throw 'unknown action'}
