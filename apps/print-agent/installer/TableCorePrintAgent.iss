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
#define MyAppVersion "1.0.0-pilot.2"
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
// Profesionalni instalacioni audit (Deo A/B/C) — TAČNA, deterministička
// definicija "dovoljno kompletne konfiguracije da se Setup NE otvara
// ponovo automatski", ogledalo (u Pascal Script-u, koji nema JSON
// parser) AgentConfig.Validate()-a u Printing.cs: Station mora biti
// KITCHEN/BAR, PrinterName ne sme biti prazan, PaperWidthMm mora biti
// 58/80. Ako se TA definicija ikad promeni u Printing.cs, OVA funkcija
// mora ostati usaglašena. Namerno tekstualna (Pos-bazirana) provera
// umesto pravog JSON parsiranja: Inno Pascal Script nema ugrađen JSON
// parser, a jedini pisac ovog fajla je SetupForm.OnSave (uvek isti,
// kontrolisan, UVLAČEN (WriteIndented=true, RAZMAK posle svake dvotačke)
// oblik: {"station": "...", "printerName": "...", "paperWidthMm": N}) —
// pa je tekstualna provera bezbedna u praksi — najgori mogući ishod
// pogrešnog tumačenja je da se Setup otvori KAD NIJE STROGO neophodno
// (bezopasno, korisnik samo vidi već popunjen ekran), NIKAD obrnuto u
// stvarnom (ne veštački oštećenom) fajlu.
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

  // Deo C — upareno, ali fajl sa stanicom/štampačem/papirom uopšte ne
  // postoji -> nepotpuna konfiguracija, Setup je OBAVEZAN.
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

  // Deo C nastavak — fajl postoji ali izgleda oštećen/nepotpun (bilo koje
  // od obaveznih polja nedostaje ili je prazno) -> Setup je OBAVEZAN.
  // Deo B — sve prisutno i izgleda ispravno -> Setup se NE otvara ponovo
  // (nadogradnja preko već podešene instalacije nastavlja automatski).
  //
  // KRITIČNO (otkriveno sopstvenim self-testom, ne pretpostavkom): stvaran
  // fajl piše SetupForm.OnSave sa JsonSerializerOptions.WriteIndented=true,
  // koje ubacuje RAZMAK POSLE SVAKE DVOTAČKE ("station": "KITCHEN", ne
  // "station":"KITCHEN") — provera BEZ razmaka nikad ne bi pogodila stvaran
  // fajl, što bi značilo da NeedsSetupAfterInstall UVEK vraća True (Setup
  // bi se ponovo otvarao na SVAKOJ nadogradnji, čak i potpuno podešenoj) —
  // vidi SelfTests.cs za test koji ovo sada čuva usaglašenim.
  Result :=
    (Pos('"station": "KITCHEN"', ConfigContent) = 0) and (Pos('"station": "BAR"', ConfigContent) = 0);
  if not Result then
    Result := (Pos('"printerName": ""', ConfigContent) > 0) or (Pos('"printerName": null', ConfigContent) > 0) or (Pos('"printerName"', ConfigContent) = 0);
  if not Result then
    Result := (Pos('"paperWidthMm": 58', ConfigContent) = 0) and (Pos('"paperWidthMm": 80', ConfigContent) = 0);
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
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop {#MyServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
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
