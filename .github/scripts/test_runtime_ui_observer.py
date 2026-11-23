import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('runtime',Path(__file__).with_name('v3_qualification.py'))
q=importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


class ObserverTests(unittest.TestCase):
    def run_runtime(self,status):
        events=[]
        class Process:
            pid=123456
            def __init__(self,command,**kwargs):
                data=Path(kwargs['env']['XDG_DATA_HOME'])/'com.artcashin.bdobb'
                data.mkdir(parents=True)
                (data/'backends.json').write_text('[]')
                events.append('launch')
            def poll(self): return None
            def wait(self,timeout): events.append('wait');return 0
            def kill(self): events.append('kill')
        def observe(pid,executable,work,evidence,arch):
            self.assertEqual(pid,Process.pid)
            self.assertNotIn('terminate',events)
            self.assertEqual(json.loads((work/'home/.local/share/com.artcashin.bdobb/backends.json').read_text()),[])
            events.append('observe')
            return {'status':status,'displayed_release_observed':status=='OBSERVED_OWNED_TOOLTIP'}
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);work=root/'work';evidence=root/'evidence';work.mkdir();evidence.mkdir()
            with patch.object(q.platform,'system',return_value='Linux'),patch.object(q.subprocess,'Popen',Process),patch.object(q.time,'sleep'),patch.object(q.os,'killpg',side_effect=lambda *args:events.append('terminate')),patch.object(q,'run',return_value=types.SimpleNamespace(stdout='123\n')):
                try:
                    result=q.native_runtime(root/'bdobb',root/'installer.deb',work,evidence,'x86_64',ui_observer=observe)
                except ValueError:
                    result=None
        self.assertEqual(events,['launch','observe','terminate','wait'])
        return result

    def test_owned_ui_observer_runs_after_fresh_profile_before_process_cleanup(self):
        result=self.run_runtime('OBSERVED_OWNED_TOOLTIP')
        self.assertTrue(result['displayed_version_ui']['displayed_release_observed'])
        self.assertEqual(result['status'],'PASS')

    def test_observer_identity_failure_blocks_runtime_and_still_cleans_up(self):
        self.assertIsNone(self.run_runtime('ERROR_PROCESS_IDENTITY'))


if __name__=='__main__':unittest.main()
