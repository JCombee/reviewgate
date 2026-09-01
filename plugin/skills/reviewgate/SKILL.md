---
name: reviewgate
description: Leg uit hoe de ReviewGate-commitgate werkt en hoe je de feedback eruit verwerkt. Gebruik dit wanneer een commit geblokkeerd wordt met "Code review: changes requested", wanneer de gebruiker vraagt waarom een commit niet doorgaat, of wanneer je een review wil openen zonder te committen.
---

# ReviewGate

Elke `git commit` in deze repo gaat langs een menselijke review. Een PreToolUse-hook
onderschept het commando, opent een review in de browser en blokkeert tot er een
beslissing is. Die deny geldt in elke permission mode, dus de gate is niet te omzeilen.

## Wat je moet doen als een commit geblokkeerd wordt

De feedback komt terug als markdown, gegroepeerd per bestand, met regelnummers.

1. **Punten zonder `?`** zijn dingen om te fixen. Doe dat in de code.
2. **Punten met `?`** zijn vragen. Beantwoord die in je antwoord aan de gebruiker;
   die hoef je niet te fixen.
3. Staat er een **Samenvatting** bovenaan, lees die eerst: hij geeft de volgorde
   en de richting, en gaat vóór de losse punten.
4. Staat er een **Commit message**-blok, gebruik dan exact die message.
5. Commit daarna opnieuw. Er volgt een nieuwe ronde van dezelfde review, waarin de
   reviewer ziet of je eerdere punten zijn opgevolgd.

## Wat je niet moet doen

- Niet `--no-verify` gebruiken. Dat wordt geweigerd met een aparte melding.
- Niet stagen en committen in één commando als je het kunt scheiden. Met
  `git add -A && git commit` staat er op hook-tijd nog niets in de index, dus
  reviewt de gate de hele working tree.
- Niet zelf in `.git/reviewgate/` schrijven.

## Een review openen zonder te committen

`reviewgate open --staged` toont de gestagede wijzigingen, `--working` de hele
working tree. Het commando print een URL; geef die aan de gebruiker.
