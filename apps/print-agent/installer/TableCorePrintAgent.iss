; Faza 2C — TableCore Print Agent instaler (Inno Setup).
;
; Instalira SAMOSTALAN (self-contained, single-file) win-x64 objavljen exe
; (dotnet publish -c Release — vidi ../TableCore.PrintAgent.csproj) pod
; Program Files, registruje ga kao Windows servis pod EMPIRIJSKI dokazanim
; identitetom "NT SERVICE\TableCorePrintAgent" (vidi AgentService.cs —
; NIJE pretpostavka: NetworkService/LocalService su testirani i
; ODBAČENI na stvarnoj Windows 10 radnoj stanici zbog lokalne "Log on as a
; service" politike; per-service virtuelni nalog RADI, ali SAMO ako je
; binarni fajl u sistemskoj lokaciji kao Program Files, ne u korisničkom
; profilu — otud DefaultDirName ispod).
;
; Instalacija ZAHTEVA elevaciju (registracija servisa) — SAMA usluga posle
; toga radi BEZ administratorskih prava (sekcija 9 zahteva: "installer may
; require elevation... runtime should not").
;
; NIKAD ne ugrađuj: produkcione tajne, AUTH_SECRET, test DATABASE_URL, kod
; za uparivanje, developer putanje. Jedina URL vrednost ovde je javna
; produkciona adresa (https://tablecore.net), koju agent već koristi kao
; podrazumevanu (vidi PairingClient.cs) — instaler je ovde NE prepisuje niti
; ubacuje ništa dodatno.

#define MyAppName "TableCore Print Agent"
; Konsolidacija — eksplicitna interna pilot oznaka, NE javno stabilno
; izdanje (nije potpisano, Windows 11 fizička prihvatna provera na
; stvarnom hardveru je i dalje na čekanju). MORA se poklapati sa
; AgentVersion.Current u AgentRunner.cs.
#define MyAppVersion "1.0.0-pilot.1"
#define MyAppPublisher "TableCore"
#define MyServiceName "TableCorePrintAgent"
#define MyServiceAccount "NT SERVICE\TableCorePrintAgent"
; Fiksan GUID — NIKAD menjati posle prvog objavljivanja; Inno ga koristi da
; prepozna "isti proizvod" pri nadogradnji (isti install direktorijum,
; Add/Remove Programs unos zamenjen umesto dupliranog).
#define MyAppId "{{B9D3E4B0-6C21-4B0B-9B39-7B7C9E9A6E31}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\TableCore\PrintAgent
DefaultGroupName=TableCore Print Agent
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=TableCorePrintSetup
OutputDir=dist
Compression=lzma2
SolidCompression=yes
; Interni prihvatni build bez potpisivanja (nema SignTool direktive ispod) —
; vidi izveštaj Faze 2C sekcija O
; ("CODE SIGNING REQUIRED BEFORE PUBLIC RESTAURANT DISTRIBUTION").
UninstallDisplayIcon={app}\TableCore.PrintAgent.exe
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; Objavljen exe MORA već postojati: `dotnet publish -c Release` iz
; apps\print-agent PRE pokretanja ISCC-a nad ovim skriptom.
Source: "..\bin\Release\net8.0-windows\win-x64\publish\TableCore.PrintAgent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\TableCore Print Agent Setup"; Filename: "{app}\TableCore.PrintAgent.exe"; Comment: "Uparivanje i podešavanje radne stanice"
Name: "{group}\Uninstall TableCore Print Agent"; Filename: "{uninstallexe}"

[Run]
; --- Registracija servisa (samo pri instalaciji/nadogradnji) ---
; "sc create" ne dozvoljava direktnu izmenu postojećeg servisa preko istih
; parametara — pri nadogradnji prvo bezuslovno gasimo/brišemo STARU
; registraciju servisa (config-datoteka/kredencijal/SQLite stanje u
; ProgramData OSTAJU netaknuti — servis je samo SCM registracija + binarni
; fajl, ne nosilac podataka) i registrujemo ponovo sa istim imenom, tako da
; ni jednom trenutku restoranski menadžer ne vidi grešku "servis već
; postoji". IgnoreErrors na stop/delete: prvi put instalacije servis još ne
; postoji, to NIJE greška.
Filename: "{sys}\sc.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Zaustavljam prethodnu verziju servisa (ako postoji)..."
Filename: "{sys}\sc.exe"; Parameters: "delete {#MyServiceName}"; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "create {#MyServiceName} binPath= ""{app}\TableCore.PrintAgent.exe"" start= auto obj= ""{#MyServiceAccount}"" DisplayName= ""TableCore Print Agent"""; Flags: runhidden waituntilterminated; StatusMsg: "Registrujem TableCore Print Agent servis..."
Filename: "{sys}\sc.exe"; Parameters: "description {#MyServiceName} ""Salje racune na kuhinjski/sank stampac za TableCore POS. Bezbedno je zaustaviti/pokrenuti preko Windows Usluga (Services)."""; Flags: runhidden waituntilterminated
; Faza 2C, sekcija 13 — ograničen, rastući razmak restarta posle pada
; (60s, pa 120s, pa 300s), brojač grešaka se resetuje posle 1 dana bez pada.
; NAMERNO ne "restart odmah u petlji" — to je izričito zabranjeno.
Filename: "{sys}\sc.exe"; Parameters: "failure {#MyServiceName} reset= 86400 actions= restart/60000/restart/120000/restart/300000"; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "start {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Pokrećem TableCore Print Agent..."
; Setup ekran se otvara na kraju SAMO ako korisnik to izabere (checkbox
; ispod) — dvoklik na EXE bez argumenata otvara WinForms uparivanje
; (Program.cs, args.Length == 0 grana), NIKAD komandnu liniju/PowerShell.
Filename: "{app}\TableCore.PrintAgent.exe"; Description: "Uredi radnu stanicu (upari, izaberi štampač) sada"; Flags: postinstall nowait skipifsilent unchecked

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete {#MyServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteService"

[Code]
// Faza 2C, sekcija 21 — deliberatna odluka: PODRAZUMEVANO ČUVAJ kredencijal/
// stanje (ProgramData\TableCore\PrintAgent) pri deinstalaciji, jer slučajan
// gubitak kredencijala tera na ponovno uparivanje. Postavljanje/skidanje
// ovog izbora je EKSPLICITNA, svesna radnja korisnika na kraju
// deinstalacije — ne podrazumevano ponašanje.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ProgramDataDir: string;
  Response: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    ProgramDataDir := ExpandConstant('{commonappdata}\TableCore\PrintAgent');
    // Tiha deinstalacija (/VERYSILENT, npr. buduć automatizovan upgrade
    // put) NEMA nikoga da odgovori na MsgBox — podrazumevano ČUVAJ u tom
    // slučaju (isti izbor kao MB_DEFBUTTON2 ispod), NIKAD ne pretpostavljaj
    // brisanje bez eksplicitnog interaktivnog odgovora korisnika.
    if UninstallSilent then
    begin
      Exit;
    end;
    if DirExists(ProgramDataDir) then
    begin
      Response := MsgBox(
        'TableCore Print Agent je uklonjen.' + #13#10 + #13#10 +
        'Sacuvan kredencijal za uparivanje i istorija stampe su ZADRZANI ' +
        '(' + ProgramDataDir + ') tako da ponovna instalacija NE zahteva ' +
        'ponovno uparivanje.' + #13#10 + #13#10 +
        'Da li zelite da TRAJNO obrisete i te podatke (kredencijal ce morati ' +
        'da se upari ponovo posle sledece instalacije)?',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2);
      if Response = IDYES then
        DelTree(ProgramDataDir, True, True, True);
    end;
  end;
end;
