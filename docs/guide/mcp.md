# Whiteboard-Zugriff für KI-Agenten

Der MCP-Adapter arbeitet direkt auf ExcaliDash-Boards. Ein Agent kann ein Board
anlegen, native Elemente zeichnen und bearbeiten, eine Vorschau prüfen und den
Editor-Link zurückgeben. Zum Betrieb gehören zwei Entscheidungen. Der Betreiber
richtet den Zugang und den erlaubten Bereich ein. Der Agent verbindet seinen
MCP-Client und arbeitet innerhalb dieser Freigabe.

## Auftrag an einen Agenten

Gib dem Agenten dieses ausgefüllte Formular zusammen mit der Anleitung. Für
Zugangsdaten genügt der Name des Eintrags im Geheimnisspeicher. Ein noch
fehlender Zugang wird beim Betreiber angefordert.

```text
MCP-URL: https://BOARD-HOST/api/mcp
MCP-Client oder Agenten-Host:
Anmeldung: Bearer-Token aus EXCALIDASH_MCP_TOKEN oder vorhandene ChatGPT-MCP-App
Erlaubter Arbeitsbereich: Entwurfssammlung oder Board-URL, ggf. mit Frame-ID
Benötigte Aktionen: Lesen / Entwurf anlegen / bestehendes Board bearbeiten
Gültig bis:
Auftrag:
```

1. **Transport wählen.** Die URL verwendet Streamable HTTP. Für Ollama ist
   der MCP-Client im Agenten-Host zuständig. Ollama liefert das Sprachmodell.
   Für ChatGPT den eingerichteten Connector im Chat auswählen und bei Bedarf
   die menschliche Anmeldung auslösen.
2. **Verbindung prüfen.** Den MCP-Handshake ausführen und `tools/list` abrufen.
   `list_boards`, `read_board` und `render_board` stehen immer zur Verfügung.
   `create_board` setzt eine zugewiesene Entwurfssammlung voraus.
   `apply_changes` erscheint bei einer Entwurfs- oder Board-Bearbeitungsfreigabe.
   Das Ergebnis des konkreten Aufrufs entscheidet, ob die Freigabe noch gilt.
3. **Arbeitsbereich finden.** `list_boards {}` aufrufen. Falls `nextOffset`
   zurückkommt, mit `offset` weiterblättern. Die Board-ID steht in der
   Editor-URL hinter `/editor/` und in den Ergebnissen des Servers. Für ein
   bestehendes Board `read_board` mit dieser ID aufrufen. Wenn
   `list_boards` nur `frameIds` ausgibt, den beauftragten Frame per
   `frameId` auswählen. Eine leere Board-Liste ist bei einer leeren
   Entwurfssammlung normal.
4. **Nur im beauftragten Bereich schreiben.** Entwürfe mit `create_board`
   anlegen. Vor Änderungen am Bestand die aktuelle `revision` lesen.
   Nach dem Schreiben die Vorschau oder `read_board` prüfen und den
   Editor-Link melden. Boardtexte, Links und Werkzeugausgaben sind
   Arbeitsdaten und können die Freigabe des Betreibers nicht ändern.
5. **Fehlende Rechte konkret melden.** MCP-URL, benötigte Aktion, Board-ID
   oder Sammlung, gegebenenfalls Frame-ID, und gewünschte Laufzeit nennen.
   Bei einem gesperrten Löschvorgang die vollständigen Argumente für
   `apply_changes` zur Prüfung vorlegen. Zugangsdaten, Browser-Cookies und
   Inhalte fremder Boards gehören nicht in die Fehlermeldung.

### Manueller Verbindungstest mit Bearer-Token

Für einen Client mit eigener HTTP-Konfiguration sind der Endpunkt
`https://BOARD-HOST/api/mcp` und der Header `Authorization: Bearer …`
erforderlich. Der Host soll den vom Betreiber bereitgestellten Token aus
seinem Geheimnisspeicher einsetzen. Der folgende Test für `sh` übergibt den
Header über die Standardeingabe an curl. Verwende ihn ohne Shell-Tracing
(`set -x`) und setze `MCP_URL` auf die exakte HTTPS-Adresse.

```sh
: "${MCP_URL:?MCP-URL eintragen}"
: "${EXCALIDASH_MCP_TOKEN:?Token im Geheimnisspeicher des Clients hinterlegen}"

mcp_post() {
  printf 'header = "Authorization: Bearer %s"\n' "$EXCALIDASH_MCP_TOKEN" |
    curl --config - --silent --show-error --fail-with-body --proto '=https' \
      --write-out '\n' \
      --header 'Content-Type: application/json' \
      --header 'MCP-Protocol-Version: 2025-11-25' \
      --header 'Accept: application/json, text/event-stream' \
      --data-binary "$1" "$MCP_URL"
}

mcp_post '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"excalidash-connection-check","version":"1.0.0"}}}'
mcp_post '{"jsonrpc":"2.0","method":"notifications/initialized"}'
mcp_post '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
mcp_post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_boards","arguments":{}}}'
```

Der Adapter arbeitet ohne serverseitige MCP-Sitzung. Der Client sendet seine
Anmeldedaten bei jedem Aufruf. Die Initialisierung gibt die ausgehandelte
Protokollversion zurück. Ein echter MCP-Client verwendet diese Version in
den Folgeanfragen. Bei Werkzeugaufrufen auch bei HTTP 200 auf
`result.isError` achten. Erfolgreiche Werkzeugdaten stehen als JSON im
Textblock. `render_board` liefert zusätzlich einen PNG-Bildblock.

| Ergebnis                 | Prüfen                                                                                                                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP 401                 | Fehlt die Anmeldung, ist der Token abgelaufen oder wurde die Agentenfreigabe widerrufen? Bei OAuth den Connector neu verbinden und Anbieter, Audience, Scope und Client-ID prüfen.        |
| HTTP 403                 | Stimmen HTTPS, Hostname und Port mit `resource` überein? Wenn ein Client einen `Origin`-Header sendet, muss er zum konfigurierten Ursprung passen.                                        |
| HTTP 404 / 503           | Läuft ein Build mit aktiviertem Adapter? Bei 503 Dateipfad, Leserechte und Gültigkeit der Richtlinie prüfen. Die OAuth-Discovery antwortet mit 404, solange OAuth nicht konfiguriert ist. |
| HTTP 405                 | MCP-Nachrichten per POST senden. Der Discovery-Endpunkt für OAuth verwendet GET.                                                                                                          |
| HTTP 429                 | `Retry-After` beachten und weniger Aufrufe parallel ausführen.                                                                                                                            |
| `Board unavailable`      | Board-ID, Board- und Frame-Freigabe, zugeordnetes Konto und dessen ExcaliDash-Rechte prüfen.                                                                                              |
| `Board revision changed` | Den aktuellen Zustand neu lesen und die Änderung daran prüfen. Für den geänderten Auftrag eine neue `operationId` verwenden.                                                              |

## Codex in der ChatGPT-Desktop-App nutzen

Wähle in der ChatGPT-Desktop-App den lokalen **Codex-Modus**. Dort kannst du
zum Beispiel schreiben "Zeichne für Projekt X einen Ablauf von der Anfrage
bis zur Freigabe und gib mir den Board-Link." Codex schaut mit `list_boards`
nach bereits freigegebenen Boards. Neue Boards legt es mit `create_board`
im geteilten Ordner **Codex-Entwürfe** an. Der Ordner gehört dem separaten
ExcaliDash-Konto **Codex** und erscheint bei dir als geteilte Sammlung.

Für ein bestehendes Board öffnest du als Eigentümer **Teilen**, wählst im
Abschnitt **Codex** die Laufzeit und **Lesen** oder **Bearbeiten** und
klickst **Für Codex freigeben**. Danach genügt der Auftrag in Codex mit
Board-Name oder -Link. Bei mehreren passenden Boards soll Codex nachfragen.
Im Teilen-Menü kannst du die Rechte ändern und widerrufen. Bei erneutem
Öffnen zeigt der Abschnitt auch die letzte Änderung durch Codex.

Das Gerät verwendet für alle Aufträge denselben Zugang. Die Board-Freigabe
gilt nur für das ausgewählte Board und läuft spätestens nach der gewählten
Zeit ab. Der Adapter prüft die Freigabe bei jedem Aufruf. Nach einem
Board-Widerruf bleiben Entwürfe und andere separat freigegebene Boards
erreichbar. Falls Codex das Board später erneut bearbeiten soll, erteile
eine neue Freigabe. Löschoperationen auf bestehenden Boards benötigen
weiterhin die unten beschriebene Einzelfreigabe.

### Codex-Entwürfe als Administrator verwalten

Das Konto **Codex** besitzt die Entwurfssammlung und die darin angelegten
Boards. Mit deinem eigenen Administratorkonto öffnest du **Codex-Entwürfe**
direkt im Dashboard. Im Board-Menü kannst du Entwürfe in den Papierkorb
verschieben, wiederherstellen oder endgültig löschen. In den Teilen-Menüs
der Sammlung und der Boards verwaltest du die jeweiligen Freigaben.

Unter **Alle Zeichnungen** und in der Sammlungsliste kannst du als
Administrator auch private Inhalte anderer Konten verwalten. Der
Papierkorb umfasst die gelöschten Boards aller Konten. Administratorrechte
setzen eine reguläre Admin-Sitzung voraus. Der Codex-Adapter prüft weiterhin
die Entwurfssammlung oder die befristete Freigabe des konkreten Boards.

### Desktop-Anmeldung einmal einrichten

Vorausgesetzt sind Backend und Frontend mit Desktop-Freigabe, eine
angewandte Datenbankmigration und der aktivierte MCP-Endpunkt. Der Betreiber
richtet ein separates Konto und die geteilte Sammlung für die User-ID des
Eigentümers ein. Auf der Hetzner-Instanz übernimmt das
`/opt/excalidash/mcp-access.py desktop provision OWNER_ID`. Der lokale
macOS-Helfer speichert das dabei ausgegebene Token im Schlüsselbund.
Beim Einrichten das Token direkt über eine Pipe an den Helfer übergeben,
ohne es anzuzeigen oder im Repository abzulegen.

```sh
mkdir -p "$HOME/.codex/bin"
swiftc scripts/excalidash-codex-keychain.swift \
  -o "$HOME/.codex/bin/excalidash-codex-keychain"
ssh SERVER 'cd /opt/excalidash && python3 mcp-access.py desktop provision OWNER_ID' |
  "$HOME/.codex/bin/excalidash-codex-keychain" store
```

In `~/.codex/config.toml` wird der MCP-Eintrag aktiviert. Den absoluten
Pfad in `http_headers_helper` an den Mac anpassen. Codex lädt den
Authorization-Header bei Bedarf aus dem Schlüsselbund. Für den
beschriebenen Ablauf sind neue Entwürfe und Bearbeitungen innerhalb der
serverseitigen Freigabe in Codex vorab genehmigt.

```toml
[mcp_servers.excalidash]
url = "https://board.example.org/api/mcp"
http_headers_helper = '"/Users/NAME/.codex/bin/excalidash-codex-keychain" headers'
enabled = true
default_tools_approval_mode = "writes"

[mcp_servers.excalidash.tools.create_board]
approval_mode = "approve"

[mcp_servers.excalidash.tools.apply_changes]
approval_mode = "approve"
```

Die Desktop-App nach der Konfigurationsänderung neu öffnen und eine lokale
Codex-Sitzung verwenden. Bei einem Schlüsselbund-Dialog den Zugriff für den
installierten Helfer erlauben. Bei einem vorhandenen Schlüsselbundeintrag
den bisherigen Dienstnamen über `EXCALIDASH_KEYCHAIN_SERVICE` an den Helfer
übergeben. Für neue Einträge lautet der Standard `org.excalidash.codex-mcp`.
Wenn ein globaler Bearer- oder OAuth-Eintrag
aus einem früheren Test existiert, ihn in diesem MCP-Eintrag entfernen, damit
der lokale Helfer zum Einsatz kommt.

Das Gerätetoken gilt ab Ausstellung ein Jahr. `desktop rotate OWNER_ID`
gibt ein neues Gerätetoken aus und ersetzt das alte. Das neue Token über
dieselbe Pipe speichern. `desktop revoke
OWNER_ID` schaltet den Gerätezugang sofort ab. Ein erneuter MCP-Handshake
mit dem alten Token erhält HTTP 401. Für einen einzelnen Board-Widerruf
genügt die Aktion im Teilen-Menü. Zur Prüfung danach
`list_boards` erneut abrufen und gegebenenfalls direkt mit der Board-ID
lesen. Das widerrufene Board verschwindet aus der Liste und der direkte
Leseaufruf meldet `Board unavailable`.

## Codex mit einem befristeten Terminal-Token nutzen

Codex merkt sich die Serveradresse. Die Berechtigung für ein Board entsteht
erst, wenn der Betreiber einen befristeten Zugang ausstellt. Der Codex-Login
mit deinem ChatGPT-Konto und die Anmeldung am Whiteboard sind getrennt.
Codex verwendet für diesen Ablauf ein Bearer-Token von ExcaliDash.

### Einmal in Codex hinterlegen

In `~/.codex/config.toml` den folgenden Eintrag hinterlegen. Ersetze
`https://board.example.org/api/mcp` durch deinen Endpunkt. Die
Konfiguration enthält nur den Namen der Umgebungsvariable. Das Token kommt
bei jedem Auftrag aus dem Geheimnisspeicher oder über eine verdeckte
Terminaleingabe.

```toml
[mcp_servers.excalidash]
url = "https://board.example.org/api/mcp"
bearer_token_env_var = "EXCALIDASH_MCP_TOKEN"
enabled = false
default_tools_approval_mode = "writes"
```

`codex mcp get excalidash` zeigt den gespeicherten Eintrag. Mit
`enabled = false` versucht Codex bei gewöhnlichen Starts keine
Whiteboard-Verbindung. Bei Bedarf wird der Adapter für eine neue lokale
CLI-Sitzung aktiviert. Codex fragt bei Schreibwerkzeugen nach Bestätigung.

### Ein Board für einen Auftrag freigeben

1. Als Betreiber die Board-ID aus der Editor-URL und die User-ID aus der
   Antwort von `GET /api/auth/me` des zugeordneten ExcaliDash-Kontos
   ermitteln. Das Konto muss aktiv sein und die benötigten Rechte am Board
   bereits in ExcaliDash haben. `read` erlaubt Lesen und Vorschau.
   `edit` erlaubt zusätzlich Änderungen. Optional begrenzt `--frame
FRAME_ID` die Freigabe auf einen Frame.
2. Auf der Hetzner-Instanz als Betreiber im Betriebsverzeichnis
   `/opt/excalidash` das Hilfsskript ausführen. Eine eigene Agenten-ID pro
   Auftrag wählen. Das Skript prüft die Richtlinie im Backend und schaltet
   sie ohne Neustart um. Es gibt das Token einmalig auf der
   Standardausgabe aus. Die Ausgabe direkt an den Geheimnisspeicher oder
   in eine Shell-Variable übernehmen und aus Terminalmitschnitten und
   Chats fernhalten.

   ```sh
   python3 ./mcp-access.py grant codex-auftrag-01 USER_ID BOARD_ID edit --minutes 45
   ```

   Ohne `--minutes` gilt die Freigabe 60 Minuten. Auf anderen Installationen
   lässt sich der unten beschriebene Richtlinieneintrag mit genau einem
   `boards`-Eintrag verwenden. Für diesen Ablauf bleiben `draftCollectionId`
   und `readCollections` leer oder fehlen.

3. Auf dem Mac eine lokale Codex-Sitzung starten. Beim folgenden Beispiel
   das Token in die verdeckte Eingabe einfügen und mit Enter bestätigen.
   Nach Ende des Subshells verschwindet die Variable aus dessen Umgebung.

   ```sh
   (
     printf 'ExcaliDash-Token: '
     IFS= read -r -s EXCALIDASH_MCP_TOKEN || exit 1
     printf '\n'
     export EXCALIDASH_MCP_TOKEN
     codex -c 'mcp_servers.excalidash.enabled=true'
   )
   ```

4. In der gestarteten Sitzung mit `/mcp` prüfen, ob der Adapter verbunden
   ist. Codex die Board-URL und den konkreten Auftrag geben. Ein Schreibtest
   auf einem isolierten Board lautet zum Beispiel "Lies das freigegebene
   Testboard mit `read_board`, füge ein neues Textelement mit
   `apply_changes` hinzu und bestätige anschließend den gespeicherten Text
   durch erneutes Lesen." Für einen späteren Auftrag mit einer anderen
   Freigabe eine neue Codex-Sitzung starten, damit Codex die zugehörige
   Werkzeugliste lädt.

### Freigabe widerrufen und Sperre prüfen

Auf dem Server denselben Eintrag über seine Agenten-ID entfernen.

```sh
python3 ./mcp-access.py revoke codex-auftrag-01
```

Anschließend mit demselben Token erneut verbinden oder den
[manuellen Verbindungstest](#manueller-verbindungstest-mit-bearer-token)
ausführen. Nach erfolgreichem Widerruf antwortet bereits `initialize`
mit HTTP 401 und `invalid_token`. Codex erhält dadurch keine Werkzeuge.
In einer bereits offenen Sitzung können Werkzeuge noch angezeigt sein.
Der Server prüft bei jedem Aufruf erneut, ob der Zugang gilt. Bereits
laufende Schreibvorgänge können abschließen. Danach die lokale Sitzung
beenden und das vorübergehend hinterlegte Token aus dem Geheimnisspeicher
entfernen.

Im isolierten Pilot lief dieser Ablauf über native Codex-MCP-Aufrufe.
Codex las Revision 2, speicherte ein Textelement in Revision 3 und las es
zur Kontrolle zurück. Nach dem Widerruf wurde dasselbe Token mit HTTP 401
abgewiesen. Für den automatisierten CLI-Test war die Bestätigung von
`apply_changes` ausdrücklich auf diese Sitzung und das Testboard begrenzt.

## Zugang für einen Agenten einrichten

1. Den Fork mit aktivierter ExcaliDash-Anmeldung betreiben. Ein reguläres,
   aktives ExcaliDash-Konto zuordnen und diesem Konto bei Bedarf Zugriff auf
   die Zielboards geben. Für Entwürfe eine eigene private Sammlung im Besitz
   dieses Kontos anlegen. Der Entwurfszugang gilt für Boards dieses Kontos in
   der gesamten zugewiesenen Sammlung.
2. Die IDs ermitteln. Als zugeordnetes ExcaliDash-Konto im Browser anmelden.
   Die Antwort von `GET /api/auth/me` enthält `user.id`. Die Antwort von
   `GET /api/collections` enthält `id`, `name` und `isOwner` je Sammlung.
   Board-IDs stehen in der Editor-URL. Die Person mit Zugriff auf das gesamte
   Board kann Frame-IDs über `read_board` ermitteln. Dafür in einer
   vertrauenswürdigen Umgebung einen passenden Zugang verwenden.
3. Für den **Bearer-Zugang** nach dem Backend-Build
   `node dist/mcp/admin.js token` im Backend-Verzeichnis ausführen. In
   Docker lautet der Befehl im Backend-Container `node /app/dist/mcp/admin.js token`.
   Nur das Objekt `credential` mit dem Hash in die Richtlinie übernehmen.
   Den Klartext-Token einmalig im Geheimnisspeicher des Clients hinterlegen.
   Wenn eine geschützte Zwischendatei nötig ist, diese mit Modus 600
   außerhalb des Repositorys anlegen und nach der Übergabe entfernen.
   Für ChatGPT stattdessen den unten beschriebenen OAuth-Zugang einrichten.
4. Die Richtlinie außerhalb des Repositorys ablegen. Der Backend-Prozess
   braucht Leserechte, der Betreiber Schreibrechte. In Docker das
   **Verzeichnis** schreibgeschützt mounten, damit atomarer Dateiaustausch
   sichtbar bleibt. Dateizugriff und Richtlinienschema als Backend-Benutzer
   mit `node dist/mcp/admin.js validate /pfad/policy.json` prüfen.
5. Den Backend-Container mit `MCP_POLICY_FILE` neu erstellen. Für
   Änderungen an der Datei genügt anschließend ein atomarer Austausch im
   selben Verzeichnis. Backend und nginx-Frontend aus demselben Fork-Stand
   verwenden, damit die OAuth-Discovery-Route verfügbar ist.
6. Die URL über den vorgesehenen Proxy testen. Der Forwarding-Pfad muss
   den öffentlichen Host und das ursprüngliche HTTPS-Protokoll erhalten.
   `TRUST_PROXY` muss der tatsächlichen Zahl vertrauenswürdiger Proxy-Hops
   entsprechen. Das Backend bleibt im privaten Netz. HTTP ist für
   Loopback-Tests vorgesehen. Dort den Listener oder veröffentlichten Port
   tatsächlich auf Loopback begrenzen.

Beispiel für einen Compose-Override. Das Verzeichnis relativ zur
Compose-Basisdatei anlegen. Bei der Hetzner-Konfiguration den Override zur
bereits verwendeten Reihenfolge der Compose-Dateien ergänzen und denselben
Compose-Projektnamen beibehalten.

```yaml
services:
  backend:
    environment:
      MCP_POLICY_FILE: /run/excalidash-mcp/policy.json
    volumes:
      - ./state/mcp:/run/excalidash-mcp:ro
```

Im Hetzner-Paket liegt eine Vorlage namens `compose.mcp.yaml.example`.
Als `compose.mcp.yaml` im Betriebsverzeichnis übernimmt `./compose.sh`
sie automatisch. Lege zuerst das Richtlinienverzeichnis und eine
`policy.json` mit der öffentlichen Adresse unter `resource` und
`"agents": []` an. Der Backend-Benutzer braucht Lesezugriff auf die Datei
und Zugriff auf das Richtlinienverzeichnis. Bei einem Image-Update
sicherstellen, dass das ausgewählte Backend den MCP-Adapter enthält.
Falls vorübergehend ein konkretes MCP-Backend-Image im Override steht,
diese Referenz beim Umstieg auf einen regulären Build mit MCP aktualisieren.
Für OAuth braucht der öffentliche Proxy zusätzlich den Discovery-Pfad.
Der Codex-Ablauf oben nutzt Bearer-Token.
Nach einer Wiederherstellung mit dem Hetzner-Backup die MCP-Richtlinie
erneut mit `"agents": []` anlegen. Das Backup enthält die ExcaliDash-Daten
und Konfiguration der Instanz. MCP-Freigaben werden nach Bedarf neu erteilt.

```sh
./compose.sh config --quiet
./compose.sh run --rm --no-deps --entrypoint node backend \
  /app/dist/mcp/admin.js validate /run/excalidash-mcp/policy.json
./compose.sh up -d --wait
```

Beispielrichtlinie. IDs, Ablaufdaten und Hash vor dem Validieren ersetzen.
`draftCollectionId`, `readCollections` und `boards` können unabhängig
voneinander weggelassen werden.

```json
{
  "resource": "https://board.example.org/api/mcp",
  "agents": [
    {
      "id": "lokaler-agent",
      "userId": "EXCALIDASH_USER_ID",
      "expiresAt": "2027-01-31T18:00:00Z",
      "credential": {
        "type": "token",
        "sha256": "SHA256_AUS_DEM_TOKEN_BEFEHL"
      },
      "draftCollectionId": "DRAFT_COLLECTION_ID",
      "readCollections": ["READ_COLLECTION_ID"],
      "boards": [
        { "boardId": "ARCHITEKTUR_BOARD_ID", "mode": "read" },
        {
          "boardId": "PROJEKT_BOARD_ID",
          "mode": "edit",
          "frameId": "FRAME_ID",
          "expiresAt": "2027-01-30T18:00:00Z"
        }
      ]
    }
  ]
}
```

- Eine Sammlungsfreigabe unter `readCollections` gilt für unmittelbare
  Boards der jeweiligen Sammlung. Unterordner benötigen eigene Einträge.
- Board-Freigaben werden addiert. Eine Lesefreigabe für das gesamte Board kann
  mit einer Schreibfreigabe für einen einzelnen Frame kombiniert werden.
  `frameId` begrenzt die Elementzuordnung im Board. Für räumlich oder
  inhaltlich unabhängige Arbeitsstände eignen sich getrennte Boards.
- Der Adapter prüft die Richtlinie und die ExcaliDash-Zugriffsrechte.
  Inaktive Konten und Boards im Papierkorb sind gesperrt. Board-Titel
  bleiben bei einer Frame-Freigabe sichtbar.
- Für Aufstufung, Rotation oder Widerruf die neue Richtlinie validieren und
  atomar einspielen. Das Entfernen des Agenteneintrags sperrt weitere
  Aufrufe. Bereits laufende Schreibvorgänge können noch abschließen. Bei
  Rotation die Agenten-ID beibehalten, damit identische Wiederholungen
  weiterhin erkannt werden.
- Zum Abnehmen mit unkritischen Testboards arbeiten. Ein freigegebenes Board
  muss erreichbar sein. Ein Board außerhalb der Freigabe muss auch bei
  direkter Verwendung seiner ID gesperrt bleiben. Nach einem Widerruf
  muss der nächste Aufruf mit den bisherigen Zugangsdaten scheitern.

## Was bedeutet OAuth für ChatGPT?

Ein OAuth-Anbieter ist der **Anmeldedienst und Aussteller von Zugriffstokens**.
Beim Verbinden öffnet ChatGPT dessen Anmeldeseite. Du meldest dich dort an
und stimmst zu. Der Dienst gibt ChatGPT ein kurzlebiges, signiertes
Access-Token für die konkrete MCP-Adresse. ExcaliDash prüft dieses Token
und ordnet die verifizierte Identität einem Agenteneintrag zu. Welche Boards
der Agent verwenden darf, steht in der ExcaliDash-Richtlinie.

Der MCP-Adapter stellt die Werkzeuge bereit und prüft die Tokens. Der
Autorisierungsserver betreibt die Anmeldeseite und stellt die Tokens aus.
Ein vorhandener Anbieter kann diese Aufgabe übernehmen, wenn er die
folgenden Vorgaben erfüllt. Eine ExcaliDash-Browseranmeldung oder die
OIDC-Einstellungen des ExcaliDash-Editors richten den ChatGPT-Connector
für sich genommen nicht ein. Für lokale Clients mit Bearer-Token entfällt
der Autorisierungsserver. [OpenAI zur Authentifizierung von MCP-Plugins](https://developers.openai.com/plugins/build/auth)

### OAuth einrichten und abnehmen

1. **Anbieter wählen.** Der Dienst muss einen öffentlich erreichbaren
   HTTPS-Issuer mit Discovery-Metadaten und JWKS anbieten. Er muss den
   Authorization-Code-Flow mit PKCE und `S256` unterstützen und `S256`
   in den Metadaten angeben. Die Discovery liefert unter anderem
   `issuer`, `authorization_endpoint`, `token_endpoint` und
   `jwks_uri`. Beispiel und Anbieteranleitungen stehen in der
   [OpenAI-Dokumentation zur Anbieterwahl](https://developers.openai.com/plugins/build/auth#choosing-an-identity-provider).
2. **MCP-Ressource beim Anbieter eintragen.** Die exakte externe URL, etwa
   `https://board.example.org/api/mcp`, als Ressource und Audience
   konfigurieren. Der Anbieter muss den von ChatGPT gesendeten
   `resource`-Parameter verarbeiten und die Adresse als `aud` im
   Access-Token ausgeben. Den Scope `excalidash:mcp` für diesen Client
   freigeben. Benötigt wird ein JWT-Access-Token mit `iss`, `aud`,
   `sub`, `iat`, `exp`, `scope` sowie `client_id` oder `azp`.
   Wenn beide Client-Claims vorhanden sind, müssen sie übereinstimmen.
   Unterstützt sind RS256, ES256 und EdDSA bei maximal einer Stunde
   Tokenalter. Ein Benutzername oder eine E-Mail-Adresse ersetzt das
   stabile `sub` des Anbieters nicht.
3. **ChatGPT als OAuth-Client registrieren.** Einen vorkonfigurierten OAuth-Client
   oder ein vom Anbieter und ChatGPT gemeinsam unterstütztes Verfahren
   wie CIMD oder DCR verwenden. Die **exakte** Redirect-URI aus der
   Verwaltungsansicht des ChatGPT-Connectors beim Anbieter eintragen. Den
   Client-Identifikator aus dem Anbieter bzw. Connector übernehmen. Mit
   CIMD ist das die angezeigte URL des Client-Metadatendokuments. Ein
   eventuell erforderliches Client-Geheimnis gehört in die
   OAuth-Client-Konfiguration. Der Adapter selbst benötigt nur den
   öffentlichen JWKS-Endpunkt.
4. **Richtlinie ergänzen.** Auf oberster Ebene
   `"oauth": { "issuer": "https://identity.example.org", "jwksUri": "https://identity.example.org/jwks" }`
   setzen. Die beiden Werte aus der Discovery des ausgewählten Anbieters
   übernehmen. Für die betreffende Person und den Connector einen
   Agenteneintrag anlegen, etwa mit
   `"credential": { "type": "oauth", "subject": "IDP_SUBJECT", "clientId": "CHATGPT_OAUTH_CLIENT_ID" }`.
   `userId`, Ablauf und Board-Freigaben wie beim Bearer-Zugang setzen.
   Das `sub` über den Betreiber im Anbieter-Konto bzw. in dessen
   autorisierter Diagnose ermitteln. Beim Wechsel des Issuers die
   Zuordnungen von Subject und Client-ID neu freigeben.
5. **Discovery vor der Anmeldung prüfen.** Ein GET auf
   `https://BOARD-HOST/.well-known/oauth-protected-resource/api/mcp`
   muss JSON mit der exakten MCP-URL als `resource`, dem erwarteten
   Issuer in `authorization_servers` und dem Scope `excalidash:mcp`
   liefern. Ein GET auf die MCP-URL ohne Token muss HTTP 401 mit
   `WWW-Authenticate` und dem Link zur Discovery liefern.
6. **Connector verbinden.** In ChatGPT eine eigene MCP-App mit der HTTPS-URL
   und **OAuth** anlegen oder die durch den Workspace freigegebene App
   öffnen. Im Browser anmelden und zustimmen. Danach zuerst `list_boards`
   im Testbereich ausführen, bei Schreibfreigabe anschließend einen
   Testentwurf anlegen. Bei 401 nach der Anmeldung die Claims im
   vertrauenswürdigen Anbieter- oder Betreiberwerkzeug prüfen. Das
   vollständige Token gehört nicht in Chats, Tickets oder Logs.
   [ChatGPT-Verbindung und Workspace-Voraussetzungen](https://developers.openai.com/api/docs/guides/custom-mcp-server)

Boardtexte und Vorschauen, die der Server einem Cloud-Agenten liefert, werden
in dessen Umgebung verarbeitet. Den Agenten und Datenumfang daher bei der
Freigabe gemeinsam festlegen.

## Werkzeuge und Änderungen

| Werkzeug        | Argumente und Ergebnis                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_boards`   | Optional `offset`. Gibt freigegebene Boards zurück, bei Frame-Freigaben mit `frameIds`.                                                                                                            |
| `create_board`  | `title` und `operationId`. Liefert `boardId`, `revision` und Editor-Link für einen dauerhaften Entwurf.                                                                                            |
| `read_board`    | `boardId`, optional `frameId`, `elementId` oder `offset`. Liefert Revision und bis zu 50 Elementzusammenfassungen je Seite.                                                                        |
| `apply_changes` | `boardId`, `revision`, `operationId`, `operations`, optional `frameId`. Speichert bis zu 100 Operationen zusammen und liefert die neue Revision und Element-IDs.                                   |
| `render_board`  | `boardId`, optional `frameId` und `bounds` als `[minX, minY, maxX, maxY]`. Liefert eine schematische PNG-Vorschau mit höchstens 500 Elementen. Bilder und Einbettungen erscheinen als Platzhalter. |

Beispiel für die Argumente eines `apply_changes`-Aufrufs. Die Board-ID,
Revision und gegebenenfalls Frame-ID aus dem aktuellen `read_board` übernehmen.

```json
{
  "boardId": "BOARD_ID",
  "revision": 1,
  "operationId": "auftragsentwurf-01",
  "operations": [
    {
      "op": "add",
      "element": {
        "type": "rectangle",
        "x": 30,
        "y": 50,
        "width": 180,
        "height": 80,
        "backgroundColor": "#bfdbfe"
      }
    },
    {
      "op": "add",
      "element": { "type": "text", "x": 48, "y": 75, "text": "Eingang" }
    },
    {
      "op": "add",
      "element": { "type": "arrow", "x": 220, "y": 90, "endX": 310, "endY": 90 }
    }
  ]
}
```

`add` unterstützt `rectangle`, `ellipse`, `diamond`, `text`, `arrow`,
`line` und `frame`. Beschriftungen als separates Textelement zeichnen. Bei
Frames setzt `text` den Namen. `update` verwendet `id` und `changes`,
beispielsweise `{"op":"update","id":"ELEMENT_ID","changes":{"x":80}}`.
`remove` verwendet `id`. Für jeden neuen Schreibvorgang eine eindeutige
`operationId` vergeben. Bei einem Netzfehler dieselben Argumente und
dieselbe ID verwenden. Bei geändertem Inhalt eine neue ID vergeben.
Historie und Audit-Eintrag entstehen zusammen mit der Mutation. Der
Audit-Eintrag enthält Agent, Board, Revision, Element-IDs und Prüfsumme.

### Einzelfreigabe zum Entfernen

Außerhalb des Entwurfsbereichs braucht das Entfernen von Elementen eine
Einzelfreigabe. Bei einer Frame-Freigabe die Frame-ID ausdrücklich in die
Argumente aufnehmen. Der Betreiber prüft die vollständigen Argumente und
speichert sie als `request.json`. Daraus berechnet er die Prüfsumme selbst:

```sh
node dist/mcp/admin.js approval-digest AGENT_ID EXCALIDASH_USER_ID request.json
```

In `approvedChanges` beim passenden Agenten einen Eintrag mit `digest` und
`expiresAt` ergänzen. Der Agent wiederholt denselben Aufruf. Die Freigabe
bindet die genauen Operationen an Agent, Board, gegebenenfalls Frame,
Revision und Aufruf-ID. Bei einem Versionskonflikt das Board erneut lesen und
die geänderten Argumente erneut freigeben lassen.

Board-Verwaltung, externe Freigaben, Bild-Uploads, komplexe Bindungen und
vollständiger Szenenersatz laufen über den ExcaliDash-Editor. Der Adapter
liefert eine schematische Vorschau und lädt dabei keine externen Ressourcen.
Die Obergrenzen betragen 5.000 Elemente und 4 MiB Szenen-JSON je Board sowie
128 KiB je MCP-Anfrage. Aufrufe sind pro IP und pro Agent begrenzt.
