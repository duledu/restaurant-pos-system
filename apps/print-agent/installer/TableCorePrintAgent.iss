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
; AgentVersion.Current u AgentRunner.cs I <Version> u
; TableCore.PrintAgent.csproj. Profesionalni instalacioni audit —
; više MATERIJALNO različitih PREPROD kandidata je ranije objavljeno
; pod ISTIM vidljivim brojem (1.0.0-pilot.1), pa fizički test nije mogao
; sam po sebi da potvrdi KOJI je tačno instaler instaliran (samo SHA-256
; je to razlikovao). Uvećaj OVAJ broj pri SVAKOM novom fizičkom-QA
; kandidatu ubuduće.
#define MyAppVersion "1.0.0-rc.1"
#define MyAppPublisher "TableCore"
#define MyServiceName "TableCorePrintAgent"
#define MyServiceAccount "NT SERVICE\TableCorePrintAgent"
; Fiksan GUID — NIKAD menjati posle prvog objavljivanja; Inno ga koristi da
; prepozna "isti proizvod" pri nadogradnji (isti install direktorijum,
; Add/Remove Programs unos zamenjen umesto dupliranog).
#define MyAppId "{{B9D3E4B0-6C21-4B0B-9B39-7B7C9E9A6E31}"

; PREPROD pilot build — NAMERNO izolovano od podrazumevanog (produkcionog)
; puta ispod. Aktivira se ISKLJUČIVO eksplicitnim
; `ISCC /DAgentServerUrl=https://... installer\TableCorePrintAgent.iss` —
; bez tog /D argumenta, svaka linija ispod koja zavisi od AgentServerUrl
; ostaje IDENTIČNA prethodnom (hardversko-prihvaćenom) ponašanju: prazan
; AgentArgs, prazan BuildSuffix, isti OutputBaseFilename kao pre. Koristi
; POSTOJEĆI, već testirani "--mode test --server <url>" mehanizam
; (AgentEndpoint.cs) — ne uvodi novi način biranja servera. AgentEndpoint.cs
; samo po sebi odbija "--mode test --server https://tablecore.net", pa ovaj
; build strukturno ne može tiho završiti na produkciji čak ni greškom u
; vrednosti ispod.
; AgentBypassHeader — OPCIONO, SAMO kad Vercel Preview URL iznad ima
; uključen "Vercel Authentication" (Deployment Protection): Vercel na
; svom edge-u (PRE naše aplikacije) odbija SVAKI zahtev bez browser SSO
; kolačića sa 401, uključujući agentove sopstvene pozive (uparivanje/
; heartbeat/poll) — vidi AgentEndpoint.cs, BypassHeaderName. Vrednost je
; projektni "Protection Bypass for Automation" tajni token iz Vercel
; Project Settings -> Deployment Protection, NIKAD unet ovde u fajl —
; prosleđuje se ISKLJUČIVO preko ISCC /D u trenutku build-a, isto kao
; AgentServerUrl. Ako Preview URL nema Deployment Protection uključen,
; jednostavno se ne prosleđuje — bez efekta, prazan AgentArgs kao pre.
#ifndef AgentBypassHeader
  #define AgentBypassHeader ""
#endif
#ifndef AgentServerUrl
  #define AgentServerUrl ""
#endif
; Physical QA follow-up (installed-pilot.4-silently-built-as-Production
; investigation) — build-time fail-closed guard, defense in depth alongside
; AgentEndpoint.cs's own runtime refusal ("test mode cannot silently use
; tablecore.net"). Catches the specific, worse mistake of someone typing
; the PRODUCTION host as the "PREPROD" /DAgentServerUrl value by hand — a
; compile-time #error is impossible to accidentally ship, unlike a runtime
; check that only fires once the (wrong) installer is already built and
; running on a physical machine. This is intentionally NOT a fallback —
; there is no "silently use Production instead"; the build simply refuses
; to produce ANY output until the value is corrected.
#if AgentServerUrl == "https://tablecore.net"
  #error "AgentServerUrl must never be the Production host (https://tablecore.net) for a PREPROD/test build. Use installer\build-preprod.ps1, which always points at the correct PREPROD Vercel Preview URL."
#endif
#if AgentServerUrl != ""
  #if AgentBypassHeader != ""
    #define AgentArgs " --mode test --server " + AgentServerUrl + " --bypass-header " + AgentBypassHeader
  #else
    #define AgentArgs " --mode test --server " + AgentServerUrl
  #endif
  #define BuildSuffix " (PREPROD pilot)"
  #define MyOutputBaseFilename "TableCorePrintSetup-PREPROD"
#else
  #define AgentArgs ""
  #define BuildSuffix ""
  #define MyOutputBaseFilename "TableCorePrintSetup"
#endif

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}{#BuildSuffix}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\TableCore\PrintAgent
DefaultGroupName=TableCore Print Agent
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename={#MyOutputBaseFilename}
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

[Messages]
; Profesionalni instalacioni audit — restoranski korisnik je fizički video
; MEŠAVINU engleskog Inno čarobnjaka i srpskog TableCore teksta (Setup
; ekran, servisni opisi). Inno Setup 6 ne isporučuje zvaničan srpski jezički
; fajl (compiler:Serbian.isl NE postoji lokalno) — namerno NIJE preuzet
; neproveren/nezvaničan .isl fajl sa interneta (nepouzdan izvor za
; instaler koji dobija admin prava), niti je urađen pun mašinski prevod
; celog čarobnjaka (rizik od nespretnog teksta koji je EKSPLICITNO
; zabranjen). Umesto toga: ISKLJUČIVO ekrani koje SVAKI korisnik garantovano
; vidi na SVAKOJ instalaciji/nadogradnji (dobrodošlica, dugmad, "zatvori
; aplikacije", napredak, završetak) su ovde ručno prevedeni profesionalnim,
; kratkim srpskim tekstom — retko viđeni/rubni dijalozi (npr. specifične
; greške niskog nivoa) OSTAJU na engleskom kao bezbedna, poznata rezerva
; umesto rizika pogrešnog/nespretnog prevoda bez provere izvornog
; konteksta. Ovo je namerno ograničen, ali potpuno pouzdan obim.
english.ButtonBack=< &Nazad
english.ButtonNext=&Dalje >
english.ButtonInstall=&Instaliraj
english.ButtonCancel=Otkaži
english.ButtonFinish=&Završi
english.ClickNext=Kliknite na Dalje da nastavite, ili na Otkaži da izađete iz instalacije.
english.WelcomeLabel1=Dobrodošli u instalaciju programa [name]
english.WelcomeLabel2=Ovo će instalirati [name/ver] na vaš računar.%n%nPreporučuje se da zatvorite sve druge aplikacije pre nego što nastavite.
english.WizardReady=Spremno za instalaciju
english.ReadyLabel1=Instalacija je spremna da počne postavljanje programa [name] na vaš računar.
english.WizardInstalling=Instaliranje u toku
english.InstallingLabel=Sačekajte dok se [name] instalira na vaš računar.
english.FinishedHeadingLabel=Instalacija je završena
english.FinishedLabelNoIcons=Instalacija programa [name] je uspešno završena.
english.FinishedLabel=Instalacija programa [name] je uspešno završena.
english.CloseApplications=&Automatski zatvori aplikacije koje su u upotrebi
english.DontCloseApplications=&Ne zatvaraj aplikacije
english.ErrorCloseApplications=Instalacija nije mogla automatski da zatvori sve aplikacije koje koriste fajlove koje treba ažurirati. Preporučuje se da ih ručno zatvorite pre nastavka.
english.StatusClosingApplications=Zatvaranje aplikacija u toku...

[Files]
; Objavljen exe MORA već postojati: `dotnet publish -c Release` iz
; apps\print-agent PRE pokretanja ISCC-a nad ovim skriptom.
Source: "..\bin\Release\net8.0-windows\win-x64\publish\TableCore.PrintAgent.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Parameters prazno za podrazumevani (produkcioni) build — isti kao pre.
; PREPROD build ovde dodaje isti "--mode test --server <url>" koji servis
; ispod dobija, da dvoklik na prečicu OTVARA UPARIVANJE PROTIV ISTOG servera
; koji servis prati (bez ovoga bi interaktivan Setup ekran tiho pao na
; podrazumevanu produkciju dok servis u pozadini prati PREPROD — upravo
; neusaglašenost koju sekcija 1 zahteva da se eksplicitno spreči).
;
; Profesionalni audit — preimenovano iz "TableCore Print Agent Setup" u
; "Podešavanja radne stanice" (jasnije u Start meniju POD grupom "TableCore
; Print Agent" — DefaultGroupName ispod), i ovo OSTAJE JEDINI, uvek dostupan
; način da se Setup ekran ponovo otvori posle instalacije (re-uparivanje,
; promena štampača/stanice/širine papira, Test Print) — bez terminala,
; PowerShell-a, JSON-a ili services.msc.
Name: "{group}\Podešavanja radne stanice"; Filename: "{app}\TableCore.PrintAgent.exe"; Parameters: "{#AgentArgs}"; Comment: "Uparivanje i podešavanje radne stanice"
Name: "{group}\Ukloni TableCore Print Agent"; Filename: "{uninstallexe}"

[Registry]
; Printing V2 — professional Admin -> Agent pairing handoff. Admin
; generates a pairing code, clicks "Otvori TableCore Print Agent", and the
; BROWSER on this exact machine navigates to
; tablecore-print://pair?code=XXXX-XXXX-XXXX. Windows resolves that custom
; scheme through THESE registry keys (identical mechanism to vscode://,
; slack://, zoom://) and launches this same installed exe with the URI as
; its one argument — Program.cs/SetupArgumentDispatch recognizes it and
; opens the ordinary interactive Setup screen with the code pre-filled
; (never auto-submitted, never touches an already-existing pairing — see
; SetupForm.Initialize). This does NOT start a second service/process: the
; launch goes through the exact same WindowsServiceHelpers.IsWindowsService()
; check as a plain double-click, which is false for a shell/browser-invoked
; process, so it always opens the interactive UI, never AgentRunner's
; service loop. HKCR (not HKCU) because this installer already requires
; admin elevation (PrivilegesRequired=admin above) for service
; registration, so a machine-wide protocol registration costs nothing
; extra and works for every Windows account on this PC, not just the one
; that happened to install it. `uninsdeletekey` on the root key removes
; the ENTIRE tablecore-print tree on uninstall — no orphaned registration.
; The PREPROD build appends {#AgentArgs} to the registered command, same
; as the Start Menu shortcut above, so URI activation on a PREPROD-paired
; machine keeps targeting the same test server the background service
; already uses, instead of silently falling back to production.
Root: HKCR; Subkey: "tablecore-print"; ValueType: string; ValueName: ""; ValueData: "URL:TableCore Print Agent Protocol"; Flags: uninsdeletekey
Root: HKCR; Subkey: "tablecore-print"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCR; Subkey: "tablecore-print\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\TableCore.PrintAgent.exe"",0"
Root: HKCR; Subkey: "tablecore-print\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\TableCore.PrintAgent.exe"" ""%1""{#AgentArgs}"

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
; Dve POTPUNO odvojene linije (ne jedna šablonizovana sa ugnježdenim
; escape-ovanjem) — namerno, da podrazumevani (produkcioni) slučaj ostane
; bajt-za-bajt identičan već hardverski prihvaćenoj liniji, bez ikakvog
; rizika od suptilne greške u citiranju koja bi važila samo za PREPROD granu
; a slučajno pokvarila produkcioni instaler. sc.exe binPath sa argumentima
; zahteva DODATNE escape-ovane (\") navodnike OKO putanje exe-a unutar
; spoljašnjih navodnika cele vrednosti — standardan Windows servis obrazac
; za "exe sa razmacima u putanji" + argumenti.
#if AgentArgs != ""
Filename: "{sys}\sc.exe"; Parameters: "create {#MyServiceName} binPath= ""\""{app}\TableCore.PrintAgent.exe\""{#AgentArgs}"" start= auto obj= ""{#MyServiceAccount}"" DisplayName= ""TableCore Print Agent{#BuildSuffix}"""; Flags: runhidden waituntilterminated; StatusMsg: "Registrujem TableCore Print Agent servis (PREPROD)..."
#else
Filename: "{sys}\sc.exe"; Parameters: "create {#MyServiceName} binPath= ""{app}\TableCore.PrintAgent.exe"" start= auto obj= ""{#MyServiceAccount}"" DisplayName= ""TableCore Print Agent"""; Flags: runhidden waituntilterminated; StatusMsg: "Registrujem TableCore Print Agent servis..."
#endif
Filename: "{sys}\sc.exe"; Parameters: "description {#MyServiceName} ""Salje racune na kuhinjski/sank stampac za TableCore POS. Bezbedno je zaustaviti/pokrenuti preko Windows Usluga (Services)."""; Flags: runhidden waituntilterminated
; Faza 2C, sekcija 13 — ograničen, rastući razmak restarta posle pada
; (60s, pa 120s, pa 300s), brojač grešaka se resetuje posle 1 dana bez pada.
; NAMERNO ne "restart odmah u petlji" — to je izričito zabranjeno.
Filename: "{sys}\sc.exe"; Parameters: "failure {#MyServiceName} reset= 86400 actions= restart/60000/restart/120000/restart/300000"; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "start {#MyServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Pokrećem TableCore Print Agent..."
; Profesionalni instalacioni audit (fizički QA nalaz) — OVO JE BIO glavni
; problem: Setup se ranije otvarao SAMO ako korisnik primeti i OSTAVI
; čekiran opcioni checkbox na završnom ekranu ("Uredi radnu stanicu... sada",
; Flags: postinstall ... unchecked). Restoranski korisnik lako klikne
; Finish bez da primeti checkbox, i OBAVEZNO prvo podešavanje (uparivanje,
; štampač, papir) nikad se ne otvori. Sada je ovo STANJE-SVESNO i
; DETERMINISTIČKO umesto opciono:
;   - Sveža/nepodešena instalacija -> NeedsSetupAfterInstall vraća True ->
;     Setup se otvara AUTOMATSKI, bez checkbox-a, bez oslanjanja na to da
;     korisnik nešto primeti.
;   - Nadogradnja PREKO VEĆ uparene/podešene instalacije (ima kredencijal I
;     ispravan agent.config.json sa stanicom, štampačem, širinom papira) ->
;     vraća False -> Setup se NE otvara ponovo; servis se restartuje i sam
;     se ponovo poveže sa POSTOJEĆIM podešavanjem (isto kao ažuriranje
;     obične komercijalne Windows aplikacije).
;   - Postojeća ali NEPOTPUNA/oštećena konfiguracija -> vraća True -> Setup
;     se ponovo otvara automatski dok se ne dovrši.
; `skipifsilent` OSTAJE (tiha/automatizovana instalacija ne sme iznenada da
; otvori GUI prozor); `postinstall`/`unchecked` su UKLONJENI (to je upravo
; ono što je stvaralo prijavljeni "lako se ne primeti" problem).
Filename: "{app}\TableCore.PrintAgent.exe"; Parameters: "{#AgentArgs}"; Flags: nowait skipifsilent; Check: NeedsSetupAfterInstall

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop {#MyServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete {#MyServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteService"

[Code]
// Printing V2 update — profesionalni instalacioni audit (Deo A/B/C),
// TAČNA, deterministička definicija "dovoljno kompletne konfiguracije da
// se Setup NE otvara ponovo automatski", ogledalo (u Pascal Script-u, koji
// nema JSON parser) AgentConfig.ToJson()-a u Printing.cs. Routes više NIJE
// nešto što SetupForm.OnSave bira/piše direktno — server je autoritativan
// (AgentRunner.ApplyServerRoutes/PersistConfig su SADA jedino mesto koje
// piše ovaj fajl), ali OBLIK koji taj kod piše ostaje isti kontrolisan,
// UVLAČEN (WriteIndented=true, RAZMAK posle svake dvotačke) JSON —
// {"routes": [{"type": "...", "printerName": "...", "paperWidthMm": N}]}.
// AgentConfig.Validate() garantuje da SVAKA ruta u tom nizu ima NEPRAZAN
// printerName pre nego što je ikad upisana (prazna/nepodešena ruta se
// NIKAD ne uključuje — vidi workstation-service.ts getAgentRoutes, koje
// izostavlja svaku rutu bez izabranog štampača), pa je dovoljna JEDNA
// provera: da li BILO KOJI "printerName" sa stvarnom vrednošću postoji
// bilo gde u fajlu. Namerno tekstualna (Pos-bazirana) provera umesto
// pravog JSON parsiranja: Inno Pascal Script nema ugrađen JSON parser, pa
// je tekstualna provera bezbedna u praksi — najgori mogući ishod pogrešnog
// tumačenja je da se Setup otvori KAD NIJE STROGO neophodno (bezopasno,
// korisnik samo vidi već popunjen ekran), NIKAD obrnuto u stvarnom (ne
// veštački oštećenom) fajlu.
//
// "Upareno, ali nijedna ruta štampe još podešena" (prazan routes[] niz,
// npr. sveže upareno pre nego što je Admin dodao ijednu rutu) je NAMERNO
// i dalje Setup-OBAVEZNO — restoran mora videti taj status umesto da
// ekran tiho zauvek nestane; Setup sad objašnjava da se rute podešavaju u
// Admin panelu i zatvara se čim je pairing/heartbeat potvrđen, bez obzira
// na broj ruta (vidi SetupForm.OnSave) — Setup se ponovo otvara na svakoj
// narednoj nadogradnji dok bar jedna ruta stvarno ne postoji, što je
// bezopasno (samo dodatan prikaz istog ekrana), ne blokira rad servisa.
//
// HasStoredCredential() ogledalo (CredentialStore.cs): TAČNO isti uslov
// (samo postojanje fajla, DPAPI dešifrovanje se ovde ne proverava - to
// bi zahtevalo pozivanje .NET koda iz instalera, van razumnog obima).
function NeedsSetupAfterInstall(): Boolean;
var
  ProgramDataDir, CredentialPath, ConfigPath: String;
  ConfigContent: AnsiString;
begin
  ProgramDataDir := ExpandConstant('{commonappdata}\TableCore\PrintAgent');
  CredentialPath := ProgramDataDir + '\workstation-credential.dat';
  ConfigPath := ProgramDataDir + '\agent.config.json';

  // Deo A — nikad upareno (sveža instalacija) -> Setup je OBAVEZAN.
  if not FileExists(CredentialPath) then
  begin
    Result := True;
    Exit;
  end;

  // Deo C — upareno, ali fajl sa rutama uopšte ne postoji -> nijedna ruta
  // nije preuzeta sa servera, Setup je OBAVEZAN.
  if not FileExists(ConfigPath) then
  begin
    Result := True;
    Exit;
  end;

  if not LoadStringFromFile(ConfigPath, ConfigContent) then
  begin
    // Nečitljiv/zaključan fajl u ovom trenutku -> tretiraj kao nepotpuno,
    // NIKAD kao "sigurno kompletno" kad nismo mogli ni da proverimo.
    Result := True;
    Exit;
  end;

  // Deo C nastavak — fajl postoji ali nijedna ruta u njemu nema stvaran
  // štampač -> Setup OBAVEZAN. Deo B — bar jedan "printerName" sa
  // vrednošću postoji -> Setup se NE otvara ponovo (nadogradnja preko već
  // podešene instalacije nastavlja automatski). Vidi SelfTests.cs za test
  // koji ovo čuva usaglašenim sa AgentConfig.ToJson()-om.
  Result := (Pos('"printerName": "', ConfigContent) = 0);
end;

// Professional installer audit finding (upgrade reliability) — the
// [Run] section below stops/deletes/recreates the service, but [Run]
// executes AFTER [Files] has already copied the new exe. A self-contained
// .NET exe locks its own file WHILE its process is running, so upgrading
// over an already-running installation could hit a sharing violation
// (or silently leave the OLD exe's bytes in place) at the exact moment
// [Files] tries to overwrite it — this had never been physically
// exercised (only fresh installs were tested). Stopping the service
// HERE, at ssInstall (fires immediately before [Files] copying begins),
// releases that file lock in time. IgnoreErrors-equivalent behavior
// (fresh install, no prior service) via ResultCode check — a missing
// service is not a failure.
//
// Physical investigation follow-up (installed-product-version-vs-running-
// agent-version mismatch report) — `sc.exe stop` sends the stop control
// and returns; it does NOT reliably block until the service process has
// actually exited and released its file handle (unlike a bare assumption
// that ewWaitUntilTerminated on the sc.exe PROCESS is the same as waiting
// for the SERVICE to reach STOPPED). A slow graceful shutdown (closing the
// SQLite state file, an in-flight HTTP call) could still be in progress
// the instant [Files] tries to overwrite the exe. IsServiceStopped/
// StopServiceAndWait add a short, bounded (max ~5s) poll loop so [Files]
// only proceeds once the service has actually reported STOPPED — never a
// hard gate (falls through after the timeout either way, same fallback
// behavior — Inno's own "file in use" retry prompt — as before this
// change), just a real safety margin for the one upgrade scenario that had
// never been physically exercised before a real mismatch was reported.
function IsServiceStopped(): Boolean;
var
  ResultCode: Integer;
  TempFile: string;
  Lines: TArrayOfString;
  I: Integer;
begin
  // Defaults to "stopped" (never blocks the install) if we can't determine
  // status for any reason — this is best-effort hardening, not a hard gate.
  Result := True;
  TempFile := ExpandConstant('{tmp}\tcpa-scquery.txt');
  if Exec(ExpandConstant('{cmd}'), '/C "' + ExpandConstant('{sys}\sc.exe') + ' query {#MyServiceName} > "' + TempFile + '""',
     '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if LoadStringsFromFile(TempFile, Lines) then
    begin
      for I := 0 to GetArrayLength(Lines) - 1 do
        if (Pos('STATE', Lines[I]) > 0) and (Pos('STOPPED', Lines[I]) = 0) then
          Result := False;
    end;
  end;
end;

procedure StopServiceAndWait();
var
  ResultCode: Integer;
  Attempts: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Attempts := 0;
  while (not IsServiceStopped()) and (Attempts < 10) do
  begin
    Sleep(500);
    Attempts := Attempts + 1;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    StopServiceAndWait();
  end;
end;

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
