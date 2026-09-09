import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

source = Path(__file__).parents[1] / 'src/models/codex-models.py'
spec = importlib.util.spec_from_file_location('verso_codex_models', source)
models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(models)


class DiscoveryTests(unittest.TestCase):
    def check(self, payloads, tokens=('account-a',)):
        entries = [types.SimpleNamespace(runtime_api_key=token, access_token=token) for token in tokens]
        pool = Mock()
        pool._available_entries.return_value = entries
        resolver = Mock(return_value={
            'base_url': 'https://chatgpt.com/backend-api/codex',
            'credential_pool': pool,
        })
        client = Mock()
        client.__enter__ = Mock(return_value=client)
        client.__exit__ = Mock(return_value=False)
        def get(_url, *, params, headers):
            token = headers['Authorization'].removeprefix('Bearer ')
            payload = payloads[token]
            if isinstance(payload, Exception):
                raise payload
            response = Mock()
            response.json.return_value = payload
            return response
        client.get.side_effect = get
        with patch.dict(sys.modules, {
            'httpx': types.SimpleNamespace(Client=Mock(return_value=client)),
            'hermes_cli.runtime_provider': types.SimpleNamespace(resolve_runtime_provider=resolver),
        }):
            result = models.astra_available()
        resolver.assert_called_once_with(requested='openai-codex', target_model='gpt-6-astra')
        pool._available_entries.assert_called_once_with(refresh=True)
        return result

    def test_visible_live_astra_without_any_codex_cache(self):
        self.assertIs(self.check({'account-a': {'models': [{'slug': 'gpt-6-astra', 'visibility': 'list'}]}}), True)

    def test_hidden_or_absent_astra(self):
        for entries in ([], [{'slug': 'gpt-6-astra', 'visibility': 'hidden'}], [{'slug': 'gpt-5.5'}]):
            with self.subTest(entries=entries):
                self.assertIs(self.check({'account-a': {'models': entries}}), False)

    def test_failed_or_malformed_lookup_is_unknown(self):
        for payload in (RuntimeError('403 or timeout'), {'error': 'unavailable'}, {'models': None}):
            with self.subTest(payload=type(payload).__name__):
                self.assertIsNone(self.check({'account-a': payload}))

    def test_rotation_requires_every_eligible_account_to_list_astra(self):
        visible = {'models': [{'slug': 'gpt-6-astra'}]}
        self.assertIs(self.check({'account-a': visible, 'account-b': {'models': []}}, ('account-a', 'account-b')), False)
        self.assertIs(self.check({'account-a': visible, 'account-b': visible}, ('account-a', 'account-b')), True)
        self.assertIsNone(self.check({'account-a': visible, 'account-b': TimeoutError()}, ('account-a', 'account-b')))

    def test_no_eligible_credentials_is_unknown(self):
        self.assertIsNone(self.check({}, ()))


if __name__ == '__main__':
    unittest.main()
