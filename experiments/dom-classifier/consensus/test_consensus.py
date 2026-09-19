import hashlib,json,subprocess,tempfile,unittest
from pathlib import Path
SCRIPT=Path(__file__).with_name('annotate_batch.py')
def packet(): return {'schemaVersion':1,'recordType':'node','split':'validation','pageId':'p','nodeId':'n','captureHash':'c','input':'tag=a'}
def decision(method='independent_reasoned_review',component='link',positive=[]):
 r=packet();r['inputSha256']='sha256:'+hashlib.sha256(r['input'].encode()).hexdigest();r['labelingMethod']=method;r['observedAxes']={'componentType':{'complete':True,'labels':[component]},'regions':{'complete':False,'labels':[]},'purposes':{'complete':False,'labels':positive},'pageTypes':{'complete':False,'labels':[]},'contentKinds':{'complete':False,'labels':[]}};return r
class T(unittest.TestCase):
 def invoke(self,rows,n=1):
  with tempfile.TemporaryDirectory() as d:
   q=Path(d)/'q';q.mkdir()
   for s in ('train','validation','test'):(q/f'luna-{s}-blind.jsonl').write_text((json.dumps(packet())+'\n') if s=='validation' else '')
   inp=Path(d)/'d';out=Path(d)/'o';inp.write_text(''.join(json.dumps(x)+'\n' for x in rows));p=subprocess.run(['python3',SCRIPT,'--queue',q,'--decisions',inp,'--output',out,'--expected-count',str(n),'--split','validation'],text=True,capture_output=True);return p,json.loads(out.read_text()) if out.exists() else None
 def test_bad_hash(self):x=decision();x['inputSha256']='sha256:bad';self.assertNotEqual(self.invoke([x])[0].returncode,0)
 def test_duplicate(self):x=decision();self.assertNotEqual(self.invoke([x,x],2)[0].returncode,0)
 def test_heuristic(self):p,o=self.invoke([decision('heuristic_rule')]);self.assertEqual(p.returncode,0);self.assertEqual(o['source'],'heuristic')
 def test_partial(self):p,o=self.invoke([decision(positive=['navigation'])]);self.assertEqual(p.returncode,0);self.assertEqual(o['observedAxes']['purposes']['labels'],['navigation'])
 def test_taxonomy(self):self.assertNotEqual(self.invoke([decision(component='footer')])[0].returncode,0)
if __name__=='__main__':unittest.main()
