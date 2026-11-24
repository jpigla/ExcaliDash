# ExcaliDash mit SQLite auf Hetzner betreiben

Der Stack betreibt Frontend und Backend aus demselben Fork-Commit. Die
SQLite-Datenbank enthält auch die Boardbilder. Nur das Frontend hängt in
Produktion am externen Traefik-Netz `web`. Die Werte in `.env.example`
durch die eigene Domain und den vollständigen Fork-Commit ersetzen.
Produktionsdaten, Policy, Schlüssel und die ausgefüllte Konfiguration
gehören in ein geschütztes Installationsverzeichnis außerhalb des Checkouts.

## Installation und Updates

Für eine neue Instanz die Dateien aus diesem Verzeichnis nach
`/opt/excalidash` kopieren. `.env` mit Modus 600 anlegen.
`build-images.sh PFAD_ZUM_FORK VOLLSTÄNDIGER_COMMIT` baut beide Images aus
einem Git-Archiv. `init.sh` initialisiert ausschließlich ein leeres
Installationsverzeichnis. Für die Ersteinrichtung den lokalen Compose-Stack
starten, `enable-auth.py EXCALIDASH_ORIGIN EXCALIDASH_PORT` ausführen und den
Administrator über `/register` einrichten. Anschließend den Traefik-Stack
mit `./compose.sh up -d --wait` aktivieren.

Für Updates einen Integrationszweig vom Fork-`main` anlegen und den
verifizierten Upstream-Tag mergen. Tests und Merge-Review durchführen.
Die beiden Images für den Kandidaten vorab bauen und zusammen mit
Upstream-Tag, Fork-Commit und Image-IDs im Deployment-Protokoll festhalten.
`./compose.sh config --images` muss beide Kandidaten zeigen. Bei einer
übernommenen MCP-Konfiguration ein eventuell vorhandenes `image:` im
MCP-Overlay entfernen oder auf ein bewusst festgelegtes Image setzen.
Den MCP-Mount aus der Vorlage übernehmen und Schreibrechte für Policy,
Konfiguration und Schlüssel auf dem Host begrenzen.

## Sicherung und Probe

Für Sicherungen das öffentliche Recovery-Zertifikat auf dem Server
hinterlegen. Privaten Schlüssel und Passphrase getrennt auf geschütztem
Speicher halten. Für den täglichen Timer liegt eine systemd-Vorlage vor.
Sie sichert in `/var/backups/excalidash` und löscht Serverkopien nach 30 Tagen.
Mindestens eine aktuelle verschlüsselte Kopie auf getrenntem Speicher halten.

```bash
sudo ./backup.sh recovery.crt /gesicherter/pfad/backup.cms
sudo ./restore.sh /gesicherter/pfad/backup.cms /geschuetzter/pfad/recovery.key
```

Der erste Befehl nutzt die SQLite-Backup-API und sperrt die MCP-Policy
während des Snapshots. Die Sicherung enthält die Einstellungen, Schlüssel,
Datenbank, MCP-Policy und die eingesetzte Compose-Konfiguration samt
Image-Referenzen. Die Restore-Ausführung erwartet ein frisches
Installationsverzeichnis. Die gesicherte Konfiguration liegt anschließend
unter `backup-config/`. Ältere Archive unterstützen den Restore auch ohne
diesen Ordner. Zum Start im Restore die Compose-Konfiguration ausdrücklich
auswählen. Die ursprünglichen Secrets aus dem Restore weiterverwenden.

Für die Probe im Restore-Verzeichnis bei Bedarf die MCP-Vorlage aktivieren
und `EXCALIDASH_PROJECT=excalidash-rehearsal EXCALIDASH_ROUTING=isolated`
exportieren. Der Stack hängt dann in einem internen Docker-Netz ohne
Traefik-Router. Gesundheit über `./compose.sh exec -T frontend wget -qO-
http://127.0.0.1:8080/api/health` prüfen. Für Browserprüfungen einen lokalen
Proxy im isolierten Netz verwenden. Erst mit den alten Images starten,
dann auf einer Kopie die Migration mit den neuen Images ausführen.
`verify-db.py VORHER.db NACHHER.db` prüft Integrität, Fremdschlüssel und
die gespeicherten Datensätze. Vor Funktionstests mit Schreibzugriff
vergleichen. Rückwechsel mit der alten Kopie ebenfalls proben.

## Produktivwechsel

1. Wartungsfenster mit dem Backup-Timer abstimmen. Alten Stack stoppen.
   Das trennt Browser-WebSockets und MCP-Verbindungen. Finales Archiv mit
   `backup.sh --keep-stopped` und demselben `flock` wie der Timer erstellen.
   Die gesicherte Version und beide alten Image-IDs für den Rückweg erfassen.
2. Einen getrennten Installationspfad mit einer Kopie der finalen Daten
   vorbereiten. Die Konfiguration auf beide Kandidaten-Images einstellen.
   Den migrierten Stack intern starten, Daten vergleichen und Health,
   einen bestehenden Gastlink und MCP prüfen.
3. Den alten Stack bei Fehlern oder Ablauf der vereinbarten Prüffrist
   mit seiner bisherigen Konfiguration und seinem Datenstand starten.
   Sonst den Kandidaten mit der bisherigen öffentlichen Domain ins
   Traefik-Netz aufnehmen. Öffentliche Health, Frontend und MCP prüfen.
   Den Backup-Timer auf das aktive Installationsverzeichnis umstellen
   und die nächste Sicherung dort prüfen.
4. Bei Fehlern nach Freigabe produktiver Schreibzugriffe zuerst die
   Schreibzugriffe stoppen und den neuen Stand sichern. Auf dieser
   Datenbasis vorwärts reparieren oder neue Änderungen nachweislich
   übernehmen, bevor ein älterer Stand wieder live geht. Beide alten
   Images und den vor der Freigabe gesicherten Stand bis zum Abschluss
   der Nachkontrolle aufbewahren.
