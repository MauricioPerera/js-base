"""Test de sincronía del vendor js-store.

Carga docs/vendor-manifest.json y recomputa el sha256 de CADA archivo listado
bajo src/vendor/js-store/. Falla con mensaje claro si:

  - un archivo listado falta en disco,
  - un archivo listado tiene un hash distinto (alguien editó un archivo vendorizado),
  - sobra un archivo en disco que no está en el manifest.

Esto congela el vendor: cualquier edición de un archivo bajo src/vendor/js-store/
rompe CI. Los archivos vendorizados NO deben editarse jamás (re-vendorear en su
lugar); este test hace cumplir esa regla de forma determinista.

Estilo unittest como el resto de tests Python de la plantilla; stdlib puro.
"""

import hashlib
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

VENDOR_DIR = os.path.join(ROOT, "src", "vendor", "js-store")
MANIFEST = os.path.join(ROOT, "docs", "vendor-manifest.json")


def _sha256(path):
    """sha256 del archivo normalizando CRLF -> LF.

    El repo tiene core.autocrlf=true en algunos hosts (p. ej. Windows), por lo que
    un `git checkout` puede reescribir los finales de línea del vendor (LF -> CRLF)
    y cambiar el hash sin que el contenido lógico haya cambiado. Normalizar a LF
    hace el hash estable entre entornos y sigue detectando cualquier edición REAL
    del contenido de un archivo vendorizado. El manifest se genera con la misma
    normalización (ver docs/vendor-manifest.json).
    """
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        data = fh.read()
    h.update(data.replace(b"\r\n", b"\n"))
    return h.hexdigest()


def _walk_vendor_files(vendor_dir):
    """Conjunto de rutas relativas (con separador '/') de todos los archivos
    bajo vendor_dir, recursivo."""
    out = set()
    for dirpath, _dirs, files in os.walk(vendor_dir):
        for name in files:
            rel = os.path.relpath(
                os.path.join(dirpath, name), vendor_dir
            ).replace(os.sep, "/")
            out.add(rel)
    return out


class VendorSyncTests(unittest.TestCase):

    def setUp(self):
        self.assertTrue(
            os.path.isfile(MANIFEST),
            "Falta docs/vendor-manifest.json — debe generarse en el scaffold.",
        )
        with open(MANIFEST, "r", encoding="utf-8") as fh:
            self.manifest = json.load(fh)
        self.assertIn("source", self.manifest, "manifest debe declarar 'source'")
        self.assertIn("files", self.manifest, "manifest debe declarar 'files'")
        self.assertIsInstance(self.manifest["files"], dict)

    def test_vendor_dir_exists(self):
        self.assertTrue(
            os.path.isdir(VENDOR_DIR),
            "Falta el directorio src/vendor/js-store/",
        )

    def test_no_missing_listed_files(self):
        listed = set(self.manifest["files"].keys())
        on_disk = _walk_vendor_files(VENDOR_DIR)
        missing = sorted(listed - on_disk)
        self.assertEqual(
            missing, [],
            "Archivos listados en el manifest pero faltantes en disco: {}".format(
                missing,
            ),
        )

    def test_no_extra_files_on_disk(self):
        listed = set(self.manifest["files"].keys())
        on_disk = _walk_vendor_files(VENDOR_DIR)
        extra = sorted(on_disk - listed)
        self.assertEqual(
            extra, [],
            "Archivos en disco no listados en el manifest (sobran): {}".format(
                extra,
            ),
        )

    def test_hashes_match(self):
        mismatches = []
        for rel, expected in self.manifest["files"].items():
            p = os.path.join(VENDOR_DIR, rel)
            if not os.path.isfile(p):
                # ya reportado por test_no_missing_listed_files; aquí no duplicar
                continue
            actual = _sha256(p)
            if actual != expected:
                mismatches.append(
                    "{}: esperado {} pero encontrado {}".format(
                        rel, expected, actual
                    )
                )
        self.assertEqual(
            mismatches, [],
            "Hashes divergentes — ¿se editó un archivo vendorizado?:\n{}".format(
                "\n".join(mismatches),
            ),
        )

    def test_manifest_lists_all_disk_files(self):
        # Cobertura completa: el conjunto de archivos listados == conjunto en disco.
        listed = set(self.manifest["files"].keys())
        on_disk = _walk_vendor_files(VENDOR_DIR)
        self.assertEqual(
            listed, on_disk,
            "El manifest y el disco no coinciden. Solo en manifest: {}. "
            "Solo en disco: {}".format(
                sorted(listed - on_disk), sorted(on_disk - listed),
            ),
        )


if __name__ == "__main__":
    unittest.main()