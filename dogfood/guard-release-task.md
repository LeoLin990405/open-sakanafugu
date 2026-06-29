# Dogfood Guard Evidence

Observed gap: release automation asked the runtime to run `gh release create v1.2.3`
without an action certificate.

Expected guard behavior: review the privileged action unless `--certificate` is present.
