import importlib.util
import unittest
from pathlib import Path

path=Path(__file__).with_name("evaluate_diverse.py");spec=importlib.util.spec_from_file_location("evaluate_diverse",path);ev=importlib.util.module_from_spec(spec);spec.loader.exec_module(ev)
class EvaluateTests(unittest.TestCase):
 def row(self,labels,complete=True):return {"recordType":"node","pageId":"p","nodeId":"n","captureHash":"c","split":"test","source":"luna","gold":False,"observedAxes":{"regions":{"complete":complete,"labels":labels}}}
 def prediction(self,labels):return {"recordType":"node","pageId":"p","nodeId":"n","captureHash":"c","split":"test","regions":{"positiveLabels":labels}}
 def test_wrong_complete_prediction_is_zero_f1_and_empty_is_exact(self):
  score=ev.score([self.row(["footer"])],{ev.key(self.row(["footer"])):self.prediction([])})["regions"]
  self.assertEqual(score["microF1"],0.0);self.assertEqual(score["perLabel"]["footer"]["f1"],0.0);self.assertEqual(score["perLabel"]["hero"]["support"],0)
  empty=ev.score([self.row([])],{ev.key(self.row([])):self.prediction([])})["regions"]
  self.assertEqual(empty["exactSetAccuracy"],1)
 def test_partial_is_positive_only(self):
  score=ev.score([self.row(["footer"],False)],{ev.key(self.row(["footer"],False)):self.prediction(["footer"])})["regions"]
  self.assertEqual(score["completeExamples"],0);self.assertEqual(score["partialPositiveOnly"]["recall"],1);self.assertEqual(score["partialPositiveOnly"]["examples"],1)
if __name__=="__main__":unittest.main()
