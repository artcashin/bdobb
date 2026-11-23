# Definitions only. Native process/UI APIs are called only by the guarded probe.
$script:V3ExactSourceText = 'Download the corresponding source for v3.0.0 (GNU AGPL v3).'
function Get-V3IdentityToken($Record) {
    return (@($Record.Pid,$Record.Parent,$Record.Birth,$Record.Sid,$Record.Session,$Record.Image,$Record.Native,$Record.FileIdentity) -join '|')
}
function Test-V3CachedOwner($Proof,[scriptblock]$ReadProcess) {
    if (-not $Proof.Allowed) { return $false }
    try {
        foreach($identity in $Proof.Tokens) {
            if ((Get-V3IdentityToken (& $ReadProcess $identity.Pid)) -cne $identity.Token) { return $false }
        }
        return $true
    } catch { return $false }
}
function Test-V3ProcessOwner([int]$CandidatePid,$Root,[scriptblock]$ReadProcess,[scriptblock]$AssertMain) {
    $diagnostic=[ordered]@{pid=$CandidatePid;status='GAP_PID_UNAVAILABLE';same_sid=$false;same_session=$false;trusted_vendor=$false;native_x64=$false;main_ancestor=$false;depth=0}
    $proof=@{Allowed=$false;Diagnostic=$diagnostic;Tokens=@()}
    if ($CandidatePid -le 0) { return $proof }
    [void](& $AssertMain)
    try {
        $leaf=& $ReadProcess $CandidatePid
        $diagnostic.same_sid=$leaf.Sid -ceq $Root.Sid
        $diagnostic.same_session=$leaf.Session -eq $Root.Session
        $diagnostic.trusted_vendor=$leaf.VendorTrusted -eq $true
        $diagnostic.native_x64=$leaf.Native -eq $true
        if (-not $diagnostic.same_sid) {$diagnostic.status='GAP_SID_MISMATCH';return $proof}
        if (-not $diagnostic.same_session) {$diagnostic.status='GAP_SESSION_MISMATCH';return $proof}
        if (-not $diagnostic.native_x64) {$diagnostic.status='GAP_NATIVE_ARCH_MISMATCH';return $proof}
        if ($CandidatePid -ne $Root.Pid -and -not $diagnostic.trusted_vendor) {$diagnostic.status='GAP_VENDOR_BINARY_UNPROVEN';return $proof}
        $seen=New-Object 'Collections.Generic.HashSet[int]'
        $current=$leaf
        for($depth=0;$depth -le 16;$depth++) {
            $diagnostic.depth=$depth
            if (-not $seen.Add([int]$current.Pid)) {$diagnostic.status='GAP_ANCESTRY_CYCLE';return $proof}
            if ($current.Sid -cne $Root.Sid -or $current.Session -ne $Root.Session) {$diagnostic.status='GAP_ANCESTOR_OWNER_MISMATCH';return $proof}
            $proof.Tokens+=@{Pid=[int]$current.Pid;Token=(Get-V3IdentityToken $current)}
            if ($current.Pid -eq $Root.Pid) {
                if ((Get-V3IdentityToken $current) -cne (Get-V3IdentityToken $Root)) {throw 'ERROR_MAIN_IDENTITY'}
                [void](& $AssertMain)
                $proof.Allowed=$true
                if (-not (Test-V3CachedOwner $proof $ReadProcess)) {$proof.Allowed=$false;$diagnostic.status='GAP_PROCESS_CHANGED';return $proof}
                $diagnostic.main_ancestor=$true;$diagnostic.status='PROVEN_OWNED_WEBVIEW2'
                return $proof
            }
            if ($depth -eq 16 -or $current.Parent -le 0) {$diagnostic.status='GAP_ANCESTRY_UNPROVEN';return $proof}
            $parent=& $ReadProcess ([int]$current.Parent)
            if ($parent.Birth -gt $current.Birth) {$diagnostic.status='GAP_PARENT_PID_REUSED';return $proof}
            $current=$parent
        }
    } catch {
        if ($_.Exception.Message -ceq 'ERROR_MAIN_IDENTITY') {throw 'ERROR_MAIN_IDENTITY'}
        $diagnostic.status='GAP_PROCESS_PROOF_UNAVAILABLE'
    }
    return $proof
}
function New-V3UiObservation([bool]$SourceShowing,[bool]$TooltipShowing,[bool]$TooltipExact,[bool]$DescriptionExact) {
    $displayed=$SourceShowing -and $TooltipShowing -and $TooltipExact
    return [ordered]@{status=$(if($displayed){'OBSERVED_OWNED_TOOLTIP'}elseif($SourceShowing -and $DescriptionExact){'OBSERVED_UIA_HELPTEXT'}else{'NOT_OBSERVED'});
        displayed_release_observed=$displayed;accessible_release_observed=($SourceShowing -and $DescriptionExact);
        release=$(if($displayed -or ($SourceShowing -and $DescriptionExact)){'3.0.0'}else{$null});native_about='NOT_OBSERVED';
        source_control_visible=$SourceShowing;tooltip_visible=$TooltipShowing;
        observed_tooltip_text=$(if($displayed){$script:V3ExactSourceText}else{$null})}
}
function Test-V3HelpClickProof([bool]$OwnerFresh,[bool]$Visible,[bool]$PointUnchanged,[bool]$CursorMatches,[bool]$RootWindowHit,[bool]$ExactHelpHit) {
    return $OwnerFresh -and $Visible -and $PointUnchanged -and $CursorMatches -and $RootWindowHit -and $ExactHelpHit
}
function ConvertTo-V3WindowRectangle($Value) {
    if($Value -isnot [Collections.IDictionary] -or $Value.Count -ne 4){throw 'GAP_WINDOW_RECTANGLE_INVALID'}
    $rect=@{}
    foreach($key in @('left','top','right','bottom')) {
        if(-not $Value.Contains($key) -or $null -eq $Value[$key] -or $Value[$key].GetType() -notin @([int],[long]) -or
            [Math]::Abs([long]$Value[$key]) -gt 1000000){throw 'GAP_WINDOW_RECTANGLE_INVALID'}
        $rect[$key]=[long]$Value[$key]
    }
    if($rect.right -le $rect.left -or $rect.bottom -le $rect.top -or
        $rect.right-$rect.left -gt 20000 -or $rect.bottom-$rect.top -gt 20000){throw 'GAP_WINDOW_RECTANGLE_INVALID'}
    return $rect
}
function Test-V3WindowContained($Rectangle,$WorkArea) {
    $r=ConvertTo-V3WindowRectangle $Rectangle;$w=ConvertTo-V3WindowRectangle $WorkArea
    return $r.left -ge $w.left -and $r.top -ge $w.top -and $r.right -le $w.right -and $r.bottom -le $w.bottom
}
function Get-V3WindowFitPlan($Rectangle,$WorkArea,[bool]$Owned) {
    if(-not $Owned){throw 'ERROR_MAIN_IDENTITY'}
    $r=ConvertTo-V3WindowRectangle $Rectangle;$w=ConvertTo-V3WindowRectangle $WorkArea
    if(Test-V3WindowContained $r $w){return @{action='ALREADY_FITS';target=$r}}
    $width=[Math]::Min($r.right-$r.left,$w.right-$w.left);$height=[Math]::Min($r.bottom-$r.top,$w.bottom-$w.top)
    $left=[Math]::Max($w.left,[Math]::Min($r.left,$w.right-$width));$top=[Math]::Max($w.top,[Math]::Min($r.top,$w.bottom-$height))
    $target=@{left=$left;top=$top;right=$left+$width;bottom=$top+$height}
    if(-not (Test-V3WindowContained $target $w)){throw 'GAP_WINDOW_CLAMP_REFUSED'}
    return @{action='FIT_REQUIRED';target=$target}
}
function Test-V3TooltipTextProof([bool]$ContainerOwned,[bool]$ContainerVisible,[bool]$ContainerBounds,[bool]$ContainerExact,
    [bool]$LabelOwned,[bool]$LabelVisible,[bool]$LabelBounds,[bool]$LabelText,[bool]$LabelDescendant,[bool]$LabelExact) {
    return $ContainerOwned -and $ContainerVisible -and $ContainerBounds -and
        ($ContainerExact -or ($LabelOwned -and $LabelVisible -and $LabelBounds -and $LabelText -and $LabelDescendant -and $LabelExact))
}
function Test-V3PopupChain([long]$Handle,[long]$RootHandle,[int]$PopupPid,[scriptblock]$ReadWindow,[scriptblock]$OwnerProof) {
    $result=@{process_proven=$false;owner_chain=$false;root_owner=$false}
    if($Handle -le 0 -or $RootHandle -le 0 -or $PopupPid -le 0 -or -not (& $OwnerProof $PopupPid)){return $result}
    $result.process_proven=$true
    $first=& $ReadWindow $Handle
    if($first.Pid -ne $PopupPid){return $result}
    $result.root_owner=$first.RootOwner -eq $RootHandle
    $seen=New-Object 'Collections.Generic.HashSet[long]'
    for($depth=0;$Handle -ne 0 -and $depth -lt 16;$depth++) {
        if(-not $seen.Add($Handle)){return $result}
        if($Handle -eq $RootHandle){$result.owner_chain=$true;return $result}
        $current=& $ReadWindow $Handle
        if($current.Pid -le 0 -or -not (& $OwnerProof $current.Pid)){return $result}
        $Handle=$current.Owner
    }
    return $result
}
function Initialize-V3ProcessNative {
    if ('V3OwnerNative' -as [type]) {return}
    Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.IO;
public sealed class V3ProcessRecord {
 public int Pid,Parent,Session; public long Birth; public string Sid,Image;
 public ushort ProcessMachine,NativeMachine;
}
public static class V3OwnerNative {
 [StructLayout(LayoutKind.Sequential)] struct FileInfo {public uint Attributes;public FT Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
 [DllImport("kernel32.dll")] static extern bool GetFileInformationByHandle(IntPtr h,out FileInfo info);
 public static string FileIdentity(string path) {
  using(FileStream f=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
   FileInfo i;if(!GetFileInformationByHandle(f.SafeFileHandle.DangerousGetHandle(),out i)||(i.Attributes&0x410)!=0)throw new InvalidOperationException("FILE_UNAVAILABLE");
   byte[] dos=new byte[64];if(f.Read(dos,0,64)!=64||dos[0]!=77||dos[1]!=90)throw new InvalidOperationException("FILE_UNAVAILABLE");
   int offset=BitConverter.ToInt32(dos,60);if(offset<64||offset>1048576||offset+6>f.Length)throw new InvalidOperationException("FILE_UNAVAILABLE");
   f.Position=offset;byte[] pe=new byte[6];if(f.Read(pe,0,6)!=6||pe[0]!=80||pe[1]!=69||pe[2]!=0||pe[3]!=0||BitConverter.ToUInt16(pe,4)!=0x8664)throw new InvalidOperationException("FILE_UNAVAILABLE");
   return i.Volume+":"+i.IndexHigh+":"+i.IndexLow+":"+i.SizeHigh+":"+i.SizeLow+":"+i.Written.Value;
  }
 }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {
  public uint Size,Usage,Pid; public IntPtr Heap; public uint Module,Threads,Parent; public int Priority; public uint Flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
 }
 [StructLayout(LayoutKind.Sequential)] struct FT {public uint Low,High; public long Value {get{return ((long)High<<32)|Low;}}}
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h,uint flags,StringBuilder image,ref int size);
 [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h,out FT created,out FT exited,out FT kernel,out FT user);
 [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(int pid,out int session);
 [DllImport("kernel32.dll")] static extern bool IsWow64Process2(IntPtr h,out ushort process,out ushort native);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr h,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr h,int kind,IntPtr data,int size,out int needed);
 [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry entry);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot,ref Entry entry);
 static int Parent(int pid) {
  IntPtr s=CreateToolhelp32Snapshot(2,0);if(s==new IntPtr(-1))throw new InvalidOperationException("PROCESS_UNAVAILABLE");
  try {Entry e=new Entry();e.Size=(uint)Marshal.SizeOf(e);bool ok=Process32FirstW(s,ref e);int n=0;
   while(ok&&n++<65536){if(e.Pid==(uint)pid)return (int)e.Parent;ok=Process32NextW(s,ref e);}throw new InvalidOperationException("PROCESS_UNAVAILABLE");
  } finally{CloseHandle(s);}
 }
 public static V3ProcessRecord Read(int pid) {
  if(pid<=0)throw new InvalidOperationException("PROCESS_UNAVAILABLE");
  IntPtr h=OpenProcess(0x1000,false,pid);if(h==IntPtr.Zero)throw new InvalidOperationException("PROCESS_UNAVAILABLE");
  IntPtr token=IntPtr.Zero,buffer=IntPtr.Zero;
  try {int length=32768,session,needed;StringBuilder image=new StringBuilder(length);FT birth,exit,kernel,user;ushort process,native;
   if(!QueryFullProcessImageName(h,0,image,ref length)||!GetProcessTimes(h,out birth,out exit,out kernel,out user)||
      !ProcessIdToSessionId(pid,out session)||!IsWow64Process2(h,out process,out native)||!OpenProcessToken(h,8,out token))throw new InvalidOperationException("PROCESS_UNAVAILABLE");
   GetTokenInformation(token,1,IntPtr.Zero,0,out needed);if(needed<=0||needed>4096)throw new InvalidOperationException("PROCESS_UNAVAILABLE");
   buffer=Marshal.AllocHGlobal(needed);if(!GetTokenInformation(token,1,buffer,needed,out needed))throw new InvalidOperationException("PROCESS_UNAVAILABLE");
   string sid=new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value;
   return new V3ProcessRecord{Pid=pid,Parent=Parent(pid),Birth=birth.Value,Sid=sid,Session=session,Image=image.ToString(),ProcessMachine=process,NativeMachine=native};
  } finally {if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(h);}
 }
}
'@
}
function Read-V3NativeProcess([int]$ProcessId) {
    Initialize-V3ProcessNative
    $raw=[V3OwnerNative]::Read($ProcessId)
    $path=[IO.Path]::GetFullPath($raw.Image)
    $item=Get-Item -LiteralPath $path -Force
    if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'PROCESS_IMAGE_UNAVAILABLE'}
    $parent=$item.Directory
    while($parent){if($parent.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'PROCESS_IMAGE_UNAVAILABLE'};$parent=$parent.Parent}
    $identity=[V3OwnerNative]::FileIdentity($path)
    if(-not $script:V3VendorCache){$script:V3VendorCache=@{}}
    $trusted=$false
    $native=$raw.ProcessMachine -eq 0 -and $raw.NativeMachine -eq 0x8664
    foreach($base in @([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles),[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86))) {
        if(-not $base){continue}
        $prefix=[IO.Path]::GetFullPath($base).TrimEnd('\')+'\Microsoft\EdgeWebView\Application\'
        if($path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {
            $tail=$path.Substring($prefix.Length)
            if($tail -match '^\d+\.\d+\.\d+\.\d+\\msedgewebview2\.exe$') {
                $cacheKey=$path.ToLowerInvariant()+'|'+$identity
                if(-not $script:V3VendorCache.ContainsKey($cacheKey)) {
                    $signature=Get-AuthenticodeSignature -LiteralPath $path
                    $script:V3VendorCache[$cacheKey]=[bool]($signature.Status -eq 'Valid' -and $signature.SignerCertificate -and
                        $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ceq 'Microsoft Corporation')
                }
                $trusted=$script:V3VendorCache[$cacheKey]
            }
        }
    }
    return @{Pid=$raw.Pid;Parent=$raw.Parent;Birth=$raw.Birth;Sid=$raw.Sid;Session=$raw.Session;Image=$path;Native=$native;VendorTrusted=[bool]$trusted;FileIdentity=$identity}
}
